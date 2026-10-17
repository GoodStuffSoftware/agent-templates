#!/usr/bin/env node
// resource-queue.mjs: the cross-project resource queue CLI.
//
//   node <plugin>/scripts/resource-queue.mjs run --resource box:8 [--resource app-e2e[:N]]
//        [--class <id>] [--ram 4G] [--label <text>] [--max-wait <seconds>] -- <cmd...>
//   node <plugin>/scripts/resource-queue.mjs status [--json] [--resource <name>] [--sample] [--strays]
//   node <plugin>/scripts/resource-queue.mjs sweep
//   node <plugin>/scripts/resource-queue.mjs release <lease-id>
//   node <plugin>/scripts/resource-queue.mjs install-launcher
//
// `run` waits in FIFO order until every resource it asks for is free at once,
// takes them all in one lease, runs the command below normal priority, keeps the
// lease alive while it runs and releases it when the command exits (or on a
// signal; a crash is reclaimed by the stale rules). Its exit code is the
// command's. The queue itself never makes a command fail: waits are bounded and a
// broken ledger runs the command unqueued.
//
// The ledger and rules live in scripts/ci-budget.mjs; this file is the process
// side. Spec: docs/resource-queue.md. `resourceStatus` is re-exported for hooks.

import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { constants as osConstants } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireResources, inspectLease, resourceStatus, formatResourceStatus, sweepLedger, lowerOwnPriority, releaseAll, REENTRY_ENV,
  reserveResource, unreserveResource, holdMine, resumeMine, releaseLease,
} from './ci-budget.mjs';
import {
  BOX, NAME_RE, loadRules, classOf, ruleOf, limitsFor, parseRam, sampleTree, claudeHome,
} from './lib/resource-rules.mjs';

export { resourceStatus, formatResourceStatus, acquireResources, reserveResource, unreserveResource, holdMine, resumeMine, releaseLease };

const SELF = fileURLToPath(import.meta.url);
const USAGE = [
  'usage: resource-queue.mjs run --resource box:N [--resource <name>[:N]] [--class <id>] [--ram 4G] [--label <text>] [--max-wait <s>] [--group <name>] [--bind-pid <pid>] -- <cmd...>',
  '       resource-queue.mjs run --resource <name> --bind-pid <pid>          (hold for a running daemon, no command)',
  '       resource-queue.mjs reserve <resource> --for <group> --until <30m|2h|14:30|ISO> [--reason <text>]    (at most 4 h)',
  '       resource-queue.mjs unreserve <resource> [--for <group>]',
  '       resource-queue.mjs hold [--until <time>]    pause my own queued entries (keep their place)',
  '       resource-queue.mjs resume',
  '       resource-queue.mjs status [--json] [--resource <name>] [--sample] [--strays]',
  '       resource-queue.mjs release <lease-id>       release one lease by hand (a hung live holder); the process is not touched',
  '       resource-queue.mjs sweep',
  '       resource-queue.mjs install-launcher',
].join('\n');

// ---------------------------------------------------------------- request

/** "box:8" -> {name: 'box', units: 8}; "app-e2e" -> {name, units: 1}. Throws a usage error. */
export function parseResourceArg(text) {
  const m = /^([^:]+)(?::(\d+))?$/.exec(String(text));
  if (!m || (m[1] !== BOX && !NAME_RE.test(m[1]))) throw new Error(`bad --resource "${text}" (want name or name:N; names are letters, digits, . _ -)`);
  const units = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isInteger(units) || units < 1) throw new Error(`bad --resource "${text}": N must be at least 1`);
  return { name: m[1], units };
}

/**
 * "--until" text to epoch ms, or null. Accepts 90s / 30m / 2h / 1h30m (from now), HH:MM (the next
 * such local time), an ISO date-time, or epoch ms. The 4 h cap is applied by reserveResource.
 */
export function parseUntil(text, now = Date.now()) {
  const t = String(text ?? '').trim();
  let m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(t);
  if (m && t) return now + (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
  m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) {
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (/^\d{12,}$/.test(t)) return Number(t);
  const p = Date.parse(t);
  return Number.isFinite(p) && /\d{4}-\d{2}-\d{2}/.test(t) ? p : null;
}

const cwdHash =(cwd) => createHash('sha1').update(resolve(cwd)).digest('hex').slice(0, 8);

/**
 * Turn flags into a request: a class supplies defaults, explicit --resource and
 * --ram take precedence over them. Returns { box, resources, ramMb, limits, class, monitored, probe }.
 */
export function buildRequest({ resources = [], ram = null, cls = null }, rules, { cwd = process.cwd() } = {}) {
  let box = 0; const named = {}; let ramMb = 0; let limits = {}; let probe = {};
  let klass = null;
  if (cls) {
    klass = classOf(rules, cls);
    if (!klass) throw new Error(`unknown --class "${cls}" (known: ${(rules.classes ?? []).map((c) => c.id).join(', ') || 'none'})`);
    box = Math.max(0, Math.trunc(klass.box ?? 0));
    for (const [n, u] of Object.entries(klass.resources ?? {})) named[n.split('{cwd}').join(cwdHash(cwd))] = Math.max(1, Math.trunc(u) || 1);
    ramMb = Math.max(0, Math.trunc(klass.ramMb ?? 0));
    limits = Object.fromEntries(['maxHoldMs', 'idleMs', 'minHoldMs'].filter((k) => Number.isFinite(klass[k])).map((k) => [k, klass[k]]));
    probe = { ports: klass.ports ?? [], busyChildren: klass.busyChildren ?? [] };
  }
  const seenBox = resources.find((r) => r.name === BOX);
  if (seenBox) box = seenBox.units;
  for (const r of resources) if (r.name !== BOX) named[r.name] = r.units;
  if (ram !== null) ramMb = ram;
  if (!box && !Object.keys(named).length) throw new Error('nothing to wait for: give --resource box:N, --resource <name> or --class <id>');
  const idle = ruleOf(rules, 'idle');
  const lim = limitsFor(rules, { kind: 'run', units: box, resources: named, limits });
  const monitored = Boolean(idle && idle.enabled !== false && (idle.appliesTo ?? ['run']).includes('run') && lim.idleMs);
  return { box, resources: named, ramMb, limits, class: cls, monitored, probe };
}

/** Subtract what an ancestor lease already holds (re-entrancy). Returns the remainder or null when all is covered. */
export function subtractHeld(req, held) {
  const rest = { ...req, resources: { ...req.resources } };
  if (held.box >= rest.box) rest.box = 0;
  for (const [n, u] of Object.entries(held.resources ?? {})) if (rest.resources[n] !== undefined && u >= rest.resources[n]) delete rest.resources[n];
  if (held.ramMb >= rest.ramMb) rest.ramMb = 0;
  return rest.box === 0 && !Object.keys(rest.resources).length ? null : rest;
}

// ---------------------------------------------------------------- command execution

const SHELL_META = /[\s|&;<>()$`"'\\*?{}[\]~#!]/;

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function findOnPath(name, env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const hasExt = extname(name) !== '';
  for (const d of dirs) {
    for (const x of hasExt ? [''] : exts) {
      const f = join(d, name + x);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

/** A shell for a single command string: sh on POSIX; Git's bash or sh on Windows; else cmd.exe. */
function shellFor(env) {
  if (process.platform !== 'win32') return { file: '/bin/sh', args: ['-c'] };
  const git = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (git && existsSync(git)) return { file: git, args: ['-c'] };
  const sh = findOnPath('sh', env) || findOnPath('bash', env);
  if (sh) return { file: sh, args: ['-c'] };
  return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], verbatim: true };
}

const cmdQuote = (a) => (a === '' || /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/**
 * How to start `argv`. One argument holding shell syntax (a pipe, `&&`, quotes) is
 * a command line for a shell; several arguments are an exact argv (no shell, so
 * quoting survives). On Windows a bare name is resolved through PATH/PATHEXT, and
 * a .cmd or .bat (npm, npx) goes through cmd.exe, which node cannot start directly.
 */
export function planCommand(argv, env = process.env) {
  // A lone argument that names a file (a program path with a space or, on Windows,
  // backslashes) is a program, not a command line: a shell would eat its backslashes.
  if (argv.length === 1 && SHELL_META.test(argv[0]) && !isFile(argv[0])) {
    const sh = shellFor(env);
    return { file: sh.file, args: [...sh.args, argv[0]], verbatim: Boolean(sh.verbatim), mode: 'shell' };
  }
  let [file, ...args] = argv;
  if (process.platform === 'win32') {
    const found = isAbsolute(file) || /[\\/]/.test(file) ? (existsSync(file) ? file : findOnPath(file, env)) : findOnPath(file, env);
    if (found) file = found;
    if (/\.(cmd|bat)$/i.test(file)) {
      return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[file, ...args].map(cmdQuote).join(' ')}"`], verbatim: true, mode: 'cmd' };
    }
  }
  return { file, args, verbatim: false, mode: 'argv' };
}

const signalNumber = (sig) => osConstants.signals[sig] ?? 0;

// ---------------------------------------------------------------- run

function defaultLabel(cmd) {
  const toks = cmd.filter((t) => !t.startsWith('-')).slice(0, 2).map((t) => basename(t).slice(0, 40));
  return toks.join(' ') || 'command';
}

/**
 * Run a command under the queue. Returns its exit code. `io` carries test seams:
 * { env, err(line), acquire, spawn, probe, pollMs }.
 */
export async function runUnderQueue({
  request, label, cmd, maxWaitSeconds = null, group = '', bindPid = 0,
}, io = {}) {
  const env = io.env ?? process.env;
  const err = io.err ?? ((l) => process.stderr.write(`${l}\n`));
  const spawnFn = io.spawn ?? spawn;
  lowerOwnPriority();
  const off = String(env.RESOURCE_QUEUE ?? '').trim() === '0' || String(env.CI_LOCAL_LOCK ?? '').trim() === '0';
  let req = request; let lease = null;

  // Re-entrancy: an ancestor `run` already holds (part of) this request.
  const token = env[REENTRY_ENV];
  if (!off && token) {
    const held = inspectLease(token, { env, ...(io.ledger ?? {}) });
    if (held) {
      req = subtractHeld(request, held);
      if (!req) err(`resource-queue: ${wantsLine(request)} is already held by this process tree (lease ${token}); running without queueing.`);
      else err(`resource-queue: part of the request is already held (lease ${token}); queueing only for ${wantsLine(req)}.`);
    }
  }

  const abort = { done: false, code: 0 };
  const onEarly = (code) => () => { releaseAll(); process.exit(code); };
  const early = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]].map(([s, c]) => [s, onEarly(c)]);
  if (!off && req) {
    for (const [s, h] of early) process.on(s, h);
    lease = await (io.acquire ?? acquireResources)({
      env, box: req.box, resources: req.resources, ramMb: req.ramMb, label, limits: req.limits, monitored: req.monitored,
      maxWaitMs: maxWaitSeconds === null ? undefined : maxWaitSeconds * 1000, log: err, group, bindPid, ...(io.ledger ?? {}),
    });
    for (const [s, h] of early) process.off(s, h);
  }
  if (bindPid > 0 && lease?.bound) {
    // The lease now belongs to the bound pid (a daemon): no heartbeat, no release by this process.
    err(`resource-queue: ${wantsLine(request)} is held by lease ${lease.id} for as long as pid ${bindPid} runs.`);
    if (!cmd.length) return 0;
  } else if (!cmd.length) {
    err(`resource-queue: nothing is held: ${off ? 'the queue is off' : `pid ${bindPid} is not running`}.`);
    lease?.release();
    return off ? 0 : 1;
  }
  const childEnv = { ...env, ...(lease && !lease.off ? { [REENTRY_ENV]: lease.id } : {}) };
  const plan = planCommand(cmd, env);
  let child;
  try {
    child = spawnFn(plan.file, plan.args, {
      stdio: 'inherit', windowsHide: true, env: childEnv, windowsVerbatimArguments: plan.verbatim,
    });
  } catch (e) {
    lease?.release();
    err(`resource-queue: cannot start "${cmd[0]}": ${e.message}`);
    return e.code === 'EACCES' ? 126 : 127;
  }

  let probeTimer = null; let probeNoted = false;
  if (lease && !lease.off && request.monitored) {
    const rules = io.rules ?? loadRules(env);
    const idleRule = ruleOf(rules, 'idle') ?? {};
    const sampleMs = io.probeMs ?? idleRule.sampleMs ?? 30_000;
    let prev = null; let activeAt = Date.now();
    probeTimer = setInterval(() => {
      if (lease.cleared && !probeNoted) {
        probeNoted = true;
        err(`resource-queue: this lease was cleared by a rule (see "status --json" recent clears); the command keeps running.`);
      }
      const s = (io.probe ?? sampleTree)(child.pid, { prev, minCpuPct: idleRule.minCpuPct ?? 5, ...request.probe });
      if (!s) return; // unreadable: leave the sidecar alone, the lease reads "unknown", never "idle"
      prev = s;
      if (s.active) activeAt = s.at;
      lease.recordActivity(s.at, activeAt, s.ev);
    }, sampleMs);
    probeTimer.unref?.();
  }

  const fwd = (sig) => () => {
    try { child.kill(sig); } catch { /* gone */ }
    if (!abort.timer) {
      abort.timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
      abort.timer.unref?.();
    }
  };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => [s, fwd(s)]);
  for (const [s, h] of handlers) process.on(s, h);

  const code = await new Promise((done) => {
    child.on('error', (e) => {
      err(`resource-queue: cannot start "${cmd[0]}": ${e.code === 'ENOENT' ? 'command not found' : e.message}`);
      done(e.code === 'EACCES' ? 126 : 127);
    });
    child.on('exit', (c, sig) => done(c ?? (sig ? 128 + signalNumber(sig) : 1)));
  });
  clearInterval(probeTimer);
  clearTimeout(abort.timer);
  for (const [s, h] of handlers) process.off(s, h);
  if (!lease?.bound) lease?.release();
  return code;
}

function wantsLine(r) {
  return [...(r.box ? [`box:${r.box}`] : []), ...Object.entries(r.resources).map(([n, u]) => `${n}:${u}`)].join(' ');
}

// ---------------------------------------------------------------- launcher (the stable path)

export const LAUNCHER_SOURCE = `#!/usr/bin/env node
// Stable entry point for the agent-companion resource queue. Generated by
// \`resource-queue.mjs install-launcher\`; do not edit (it is rewritten when the
// plugin updates). It finds the newest installed agent-companion and runs its
// resource-queue CLI, so this path survives plugin updates. If no plugin copy is
// found, \`run\` still runs the command (unqueued), so a missing plugin never
// breaks the caller.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const home = process.env.CLAUDE_CONFIG_DIR || join(process.env.AGENT_COMPANION_HOME_OVERRIDE || homedir(), '.claude');
const ls = (d) => { try { return readdirSync(d); } catch { return []; } };
const ver = (v) => v.split('.').map((n) => parseInt(n, 10) || 0);
const cmp = (a, b) => { const x = ver(a); const y = ver(b); for (let i = 0; i < 4; i += 1) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
function find() {
  const found = [];
  for (const mk of ls(join(home, 'plugins', 'cache'))) {
    for (const v of ls(join(home, 'plugins', 'cache', mk, 'agent-companion'))) {
      const f = join(home, 'plugins', 'cache', mk, 'agent-companion', v, 'scripts', 'resource-queue.mjs');
      if (existsSync(f)) found.push({ v, f });
    }
  }
  found.sort((a, b) => cmp(b.v, a.v));
  if (found.length) return found[0].f;
  for (const mk of ls(join(home, 'plugins', 'marketplaces'))) {
    const f = join(home, 'plugins', 'marketplaces', mk, 'plugins', 'agent-companion', 'scripts', 'resource-queue.mjs');
    if (existsSync(f)) return f;
  }
  return null;
}
const argv = process.argv.slice(2);
const target = find();
if (target) {
  const m = await import(pathToFileURL(target).href);
  process.exitCode = await m.cli(argv);
} else {
  const i = argv.indexOf('--');
  if (argv[0] === 'run' && i > 0 && argv[i + 1]) {
    console.error('resource-queue: agent-companion is not installed; running the command without the queue.');
    const c = spawn(argv[i + 1], argv.slice(i + 2), { stdio: 'inherit', windowsHide: true, shell: argv.length === i + 2 });
    c.on('exit', (code) => { process.exitCode = code ?? 1; });
    c.on('error', () => { process.exitCode = 127; });
  } else {
    console.error('resource-queue: agent-companion is not installed.');
    process.exitCode = 1;
  }
}
`;

export function launcherPath(env = process.env) {
  return join(claudeHome(env), 'agent-companion', 'bin', 'resource-queue.mjs');
}

/** Write the stable launcher if it is missing or different. Idempotent; returns 'written' | 'current' | 'failed'. */
export function installLauncher(env = process.env) {
  const dest = launcherPath(env);
  try {
    try { if (readFileSync(dest, 'utf8') === LAUNCHER_SOURCE) return 'current'; } catch { /* absent */ }
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, LAUNCHER_SOURCE);
    renameSync(tmp, dest);
    return 'written';
  } catch { return 'failed'; }
}

// ---------------------------------------------------------------- CLI

function flagValue(args, i, name) {
  const v = args[i + 1];
  if (v === undefined) throw new Error(`${name} needs a value`);
  return v;
}

/** Parse and run argv (without node and script). Returns the exit code. */
export async function cli(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.out ?? ((l) => process.stdout.write(`${l}\n`));
  const err = io.err ?? ((l) => process.stderr.write(`${l}\n`));
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'run') {
      const sep = rest.indexOf('--');
      if (sep >= 0 && sep === rest.length - 1) throw new Error('run needs a command after "--"');
      const flags = sep < 0 ? rest : rest.slice(0, sep); const command = sep < 0 ? [] : rest.slice(sep + 1);
      const resources = []; let ram = null; let cls = null; let label = ''; let maxWait = null; let group = ''; let bindPid = 0;
      for (let i = 0; i < flags.length; i += 1) {
        const f = flags[i];
        if (f === '--group') {
          group = flagValue(flags, i, f);
          if (!NAME_RE.test(group)) throw new Error(`bad --group "${group}" (names are letters, digits, . _ -)`);
          i += 1;
        } else if (f === '--bind-pid') {
          bindPid = Number(flagValue(flags, i, f));
          if (!Number.isInteger(bindPid) || bindPid < 1) throw new Error(`bad --bind-pid "${flags[i + 1]}" (a process id)`);
          i += 1;
        } else if (f === '--resource') { resources.push(parseResourceArg(flagValue(flags, i, f))); i += 1; }
        else if (f === '--ram') {
          ram = parseRam(flagValue(flags, i, f));
          if (ram === null) throw new Error(`bad --ram "${flags[i + 1]}" (want 512M, 4G or megabytes)`);
          i += 1;
        } else if (f === '--class') { cls = flagValue(flags, i, f); i += 1; }
        else if (f === '--label') { label = flagValue(flags, i, f); i += 1; }
        else if (f === '--max-wait') {
          maxWait = Number(flagValue(flags, i, f));
          if (!Number.isFinite(maxWait) || maxWait < 0) throw new Error('bad --max-wait (seconds)');
          i += 1;
        } else throw new Error(`unknown option "${f}"`);
      }
      if (!command.length && !bindPid) throw new Error('run needs a command after "--" (or --bind-pid <pid> to hold for a running process)');
      const rules = io.rules ?? loadRules(env);
      const request = buildRequest({ resources, ram, cls }, rules);
      return await runUnderQueue({
        request, label: label || (command.length ? defaultLabel(command) : `pid ${bindPid}`), cmd: command, maxWaitSeconds: maxWait, group, bindPid,
      }, { ...io, env, err, rules });
    }
    if (cmd === 'reserve') {
      const [resource, ...fl] = rest;
      if (!resource || resource.startsWith('--')) throw new Error('reserve needs a resource name first');
      let forGroup = ''; let until = null; let reason = ''; let ownerPid;
      for (let i = 0; i < fl.length; i += 1) {
        if (fl[i] === '--for') { forGroup = flagValue(fl, i, '--for'); i += 1; }
        else if (fl[i] === '--until') { until = flagValue(fl, i, '--until'); i += 1; }
        else if (fl[i] === '--reason') { reason = flagValue(fl, i, '--reason'); i += 1; }
        else if (fl[i] === '--owner-pid') { ownerPid = Number(flagValue(fl, i, '--owner-pid')); i += 1; }
        else throw new Error(`unknown option "${fl[i]}"`);
      }
      if (!forGroup) throw new Error('reserve needs --for <group>: a reservation names who it is for');
      if (until === null) throw new Error('reserve needs --until <time> (for example 90m, 2h, 14:30, or an ISO time; at most 4 h)');
      const at = parseUntil(until, (io.ledger?.now ?? Date.now)());
      if (at === null) throw new Error(`bad --until "${until}" (want 30m, 2h, 14:30, an ISO time or epoch ms)`);
      const r = reserveResource({ env, resource, forGroup, until: at, reason, ownerPid, ...(io.ledger ?? {}) });
      if (!r.ok) throw new Error(r.error);
      out(`reserved ${resource} for group "${forGroup}" until ${new Date(r.reservation.endsAt).toISOString()}${r.clamped ? ' (capped at 4 h)' : ''}; `
        + `other waiters keep their place and are passed over for ${resource} only. Lift it with: unreserve ${resource}`);
      return 0;
    }
    if (cmd === 'unreserve') {
      const [resource, ...fl] = rest;
      if (!resource || resource.startsWith('--')) throw new Error('unreserve needs a resource name first');
      let forGroup = '';
      for (let i = 0; i < fl.length; i += 1) {
        if (fl[i] === '--for') { forGroup = flagValue(fl, i, '--for'); i += 1; } else throw new Error(`unknown option "${fl[i]}"`);
      }
      const r = unreserveResource({ env, resource, forGroup, ...(io.ledger ?? {}) });
      out(r.removed.length ? `lifted ${r.removed.length} reservation${r.removed.length === 1 ? '' : 's'} on ${resource}` : `no reservation on ${resource}`);
      return 0;
    }
    if (cmd === 'hold' || cmd === 'resume') {
      let until = null;
      for (let i = 0; i < rest.length; i += 1) {
        if (cmd === 'hold' && rest[i] === '--until') { until = flagValue(rest, i, '--until'); i += 1; } else throw new Error(`unknown option "${rest[i]}"`);
      }
      const at = until === null ? undefined : parseUntil(until, (io.ledger?.now ?? Date.now)());
      if (at === null) throw new Error(`bad --until "${until}"`);
      const r = cmd === 'hold' ? holdMine({ env, until: at, ...(io.ledger ?? {}) }) : resumeMine({ env, ...(io.ledger ?? {}) });
      if (!r.ok) throw new Error(r.error);
      out(cmd === 'hold'
        ? `held ${r.ids.length} of your queued entr${r.ids.length === 1 ? 'y' : 'ies'} until ${new Date(r.until).toISOString()}; they keep their place and are passed over. Undo with: resume`
        : `resumed ${r.ids.length} of your queued entr${r.ids.length === 1 ? 'y' : 'ies'}`);
      return 0;
    }
    if (cmd === 'status') {
      let json = false; let only = null; let sample = false; let strays = false;
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i] === '--json') json = true;
        else if (rest[i] === '--sample') sample = true;
        else if (rest[i] === '--strays') strays = true;
        else if (rest[i] === '--resource') { only = flagValue(rest, i, '--resource'); i += 1; }
        else throw new Error(`unknown option "${rest[i]}"`);
      }
      const st = resourceStatus({ env, sample, strays, ...(io.ledger ?? {}) });
      if (only) {
        st.resources = st.resources.filter((r) => r.name === only);
        st.queue = st.queue.filter((q) => only in q.wants);
        st.reservations = (st.reservations ?? []).filter((r) => r.resource === only);
        st.recentClears = st.recentClears.filter((c) => c.resources && only in c.resources);
      }
      out(json ? JSON.stringify(st, null, 2) : formatResourceStatus(st));
      return 0;
    }
    if (cmd === 'release') {
      if (rest.length !== 1 || rest[0].startsWith('--')) throw new Error('release needs exactly one lease id (the id shown by status)');
      const r = releaseLease({ env, id: rest[0], ...(io.ledger ?? {}) });
      if (!r.ok) throw new Error(r.error);
      const l = r.released;
      out(`released lease ${l.id} (pid ${l.pid}${l.label ? `, ${l.label}` : ''}${l.project ? ` @${l.project}` : ''}); logged in clears.jsonl as a clear by "manual". `
        + `${l.wasAlive ? 'Its process was alive and is NOT touched: stop it yourself if it is hung. ' : ''}Its wrapper will not put the lease back.`);
      return 0;
    }
    if (cmd === 'sweep') {
      const cleared = sweepLedger({ env, log: err, ...(io.ledger ?? {}) });
      out(cleared.length ? cleared.map((c) => `cleared ${c.type} pid ${c.pid} (${c.why})`).join('\n') : 'nothing to clear');
      return 0;
    }
    if (cmd === 'install-launcher') {
      const r = installLauncher(env);
      out(`${launcherPath(env)}: ${r}`);
      return r === 'failed' ? 1 : 0;
    }
    err(USAGE);
    return 2;
  } catch (e) {
    err(`resource-queue: ${e.message}`);
    err(USAGE);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cli(process.argv.slice(2));
}
