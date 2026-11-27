// One PreToolUse entry point for every Bash and PowerShell call (0.31.79).
//
// WHY. hooks.json used to start one node process per hook for these two tools: delegation-guard, bash-tail, hold-message (--event pre),
// bash-read, poll-guard and subagent-context, six processes per call. Node start-up was the cost of each one.
// This file is the single hooks.json entry for the matcher
// ^(Bash|PowerShell)$; it starts the same six checks inside ONE process and prints what Claude Code would have made of their separate outputs.
//
// HOW. Each check is the unchanged hook script, run on its own worker thread (a thread, not a process: no node start-up). The worker is given
// the hook's stdin payload and argv, and has stdout and stderr captured into shared memory; process.exit() inside a worker ends only that
// worker, so a check's exit, its catch-all fail-open paths and its exit code behave exactly as in a process of its own. No hook logic lives
// here and no hook was changed: a guard edited later is picked up with no change to this file. The workers run in parallel, as Claude Code runs
// separate matching hooks in parallel (https://code.claude.com/docs/en/hooks: "its matching hooks run in parallel"), and every check gets the
// ORIGINAL tool input: an updatedInput from one hook is not seen by another today (bash-tail.mjs says so: "Only one PreToolUse hook's
// updatedInput survives a call"), so none is applied in sequence here either.
//
// MERGE (mergeResults), in CHECKS order, the order the separate entries had in hooks.json:
//   permissionDecision   deny > defer > ask > allow (the documented precedence). Every deny reason is kept (joined, blank line between);
//                        the other decisions keep the first reason.
//   updatedInput         the first one, in list order. Only bash-tail emits one.
//   additionalContext    all values, joined with a newline.   systemMessage: likewise.
//   continue:false / stopReason / suppressOutput / decision / reason: the first one, except that continue:false from any check wins.
//   exit code            2 if any check exited 2 (its stderr, joined, is the reason; stdout JSON is passed on, as a lone hook's would be); else 0.
//   a check that exits with any other code, throws, overflows its capture buffer or passes its deadline contributes nothing: for a PreToolUse
//   hook Claude Code treats that as a non-blocking failure and the call goes on, and the other checks' output still counts.
// A single check's output is passed on byte for byte, so with one voice the dispatcher is the hook.
//
// ISOLATION. Every check has its own deadline (its old hooks.json timeout, below). At the deadline its worker is terminated, even inside a
// synchronous loop, and the rest are unaffected. The entry's timeout in hooks.json is the longest deadline plus a margin.
//
// FALLBACK. If a Claude Code version treats one combined hook differently, put the separate entries back: the snippet is in
// README.md ("Bash hook dispatcher") and in tests/bash-dispatch.test.mjs, which checks the snippet against CHECKS.
//
// Reviewer sessions: the same table as before applies. context.mjs exits a hook listed in REVIEWER_OFF_HOOKS at import, and each worker's
// argv[1] is its hook script, so that exit happens inside the worker.

import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, isAbsolute, join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));

// The checks, in the order of the separate hooks.json entries they replace. timeoutMs is the old per-hook timeout.
export const CHECKS = Object.freeze([
  { name: 'delegation-guard', script: 'delegation-guard.mjs', args: [], timeoutMs: 10000 },
  { name: 'bash-tail', script: 'bash-tail.mjs', args: [], timeoutMs: 10000 },
  { name: 'hold-message', script: 'hold-message.mjs', args: ['--event', 'pre'], timeoutMs: 5000 },
  { name: 'bash-read', script: 'bash-read.mjs', args: [], timeoutMs: 10000 },
  { name: 'poll-guard', script: 'poll-guard.mjs', args: [], timeoutMs: 10000 },
  { name: 'subagent-context', script: 'subagent-context.mjs', args: [], timeoutMs: 5000 },
]);

const OUT_CAP = 4 * 1024 * 1024;
const ERR_CAP = 64 * 1024;
const HEADER = 16; // Int32 x4: out length, err length, overflow flag, spare
const PRECEDENCE = ['deny', 'defer', 'ask', 'allow'];

// ------------------------------------------------------------------ worker side --

function runInWorker() {
  const { script, args, payload, shared } = workerData;
  const head = new Int32Array(shared, 0, 4);
  const data = new Uint8Array(shared);
  const append = (which, chunk) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    const base = which === 0 ? HEADER : HEADER + OUT_CAP;
    const cap = which === 0 ? OUT_CAP : ERR_CAP;
    const at = head[which];
    if (at + buf.length > cap) { head[2] = 1; return; }
    data.set(buf, base + at);
    head[which] = at + buf.length;
  };

  const origRead = fs.readFileSync;
  fs.readFileSync = function readFileSync(p, o) {
    if (p === 0) {
      const enc = typeof o === 'string' ? o : o && o.encoding;
      return enc ? payload : Buffer.from(payload, 'utf8');
    }
    return origRead.apply(this, arguments);
  };
  const origWrite = fs.writeSync;
  fs.writeSync = function writeSync(fd, buf, a, b) {
    if (fd !== 1 && fd !== 2) return origWrite.apply(this, arguments); // a file the hook opened itself
    const which = fd === 1 ? 0 : 1;
    if (typeof buf === 'string') { append(which, buf); return Buffer.byteLength(buf); }
    const off = Number.isInteger(a) ? a : 0;
    const len = Number.isInteger(b) ? b : buf.length - off;
    append(which, Buffer.from(buf.buffer, buf.byteOffset + off, len));
    return len;
  };
  const sink = (which) => function write(chunk, enc, cb) {
    append(which, typeof chunk === 'string' ? Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8') : chunk);
    const done = typeof enc === 'function' ? enc : cb;
    if (typeof done === 'function') done();
    return true;
  };
  process.stdout.write = sink(0);
  process.stderr.write = sink(1);
  syncBuiltinESMExports(); // named imports (readFileSync, writeSync) of node:fs see the patched functions

  const file = isAbsolute(script) ? script : join(HERE, script); // an absolute path is for the tests' own check scripts
  process.argv = [process.argv[0], file, ...args]; // as in a process of its own: scripts read argv[1] (their name) and their flags
  return import(pathToFileURL(file).href);
}

if (!isMainThread && workerData && workerData.acBashDispatch === 1) {
  runInWorker();
}

// ------------------------------------------------------------------ merging --

function parseJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

// results: [{ name, status: 'ok'|'failed', code, stdout, stderr }] in CHECKS order. Returns { code, stdout, stderr }.
export function mergeResults(results) {
  const voices = [];
  let code = 0;
  const errs = [];
  for (const r of results) {
    if (!r || r.status !== 'ok') continue; // a failed check is a non-blocking failure: no output, no exit code
    if (r.code === 2) {
      code = 2;
      if (String(r.stderr || '').trim()) errs.push(String(r.stderr).trim());
    } else if (r.code !== 0) {
      continue; // any other exit code: non-blocking, its output is not read
    }
    const raw = String(r.stdout || '');
    const json = parseJson(raw);
    if (json) voices.push({ raw, json });
  }
  const stderr = errs.join('\n');
  if (voices.length === 0) return { code, stdout: '', stderr };
  if (voices.length === 1) return { code, stdout: voices[0].raw, stderr }; // one voice: byte for byte

  const out = {};
  const hso = {};
  const decisions = [];
  const contexts = [];
  const messages = [];
  for (const { json } of voices) {
    for (const [k, v] of Object.entries(json)) {
      if (k === 'hookSpecificOutput' && v && typeof v === 'object') continue;
      if (k === 'systemMessage') { if (typeof v === 'string' && v) messages.push(v); continue; }
      if (k === 'continue') { if (v === false) out.continue = false; else if (!('continue' in out)) out.continue = v; continue; }
      if (!(k in out)) out[k] = v;
    }
    const h = json.hookSpecificOutput;
    if (h && typeof h === 'object') {
      for (const [k, v] of Object.entries(h)) {
        if (k === 'permissionDecision') { decisions.push({ d: v, reason: h.permissionDecisionReason }); continue; }
        if (k === 'permissionDecisionReason') continue;
        if (k === 'additionalContext') { if (typeof v === 'string' && v) contexts.push(v); continue; }
        if (!(k in hso)) hso[k] = v;
      }
    }
  }
  if (decisions.length) {
    const rank = (d) => { const i = PRECEDENCE.indexOf(d); return i < 0 ? PRECEDENCE.length : i; };
    const best = decisions.reduce((m, x) => (rank(x.d) < rank(m.d) ? x : m)).d;
    const same = decisions.filter((x) => x.d === best);
    hso.permissionDecision = best;
    const reasons = (best === 'deny' ? same : same.slice(0, 1)).map((x) => x.reason).filter((x) => typeof x === 'string' && x);
    if (reasons.length) hso.permissionDecisionReason = reasons.join('\n\n');
  }
  if (contexts.length) hso.additionalContext = contexts.join('\n');
  if (Object.keys(hso).length) {
    if (!hso.hookEventName) hso.hookEventName = 'PreToolUse';
    out.hookSpecificOutput = hso;
  }
  if (messages.length) out.systemMessage = messages.join('\n');
  return { code, stdout: JSON.stringify(out), stderr };
}

// ------------------------------------------------------------------ main side --

function runCheck(check, payload) {
  return new Promise((done) => {
    const shared = new SharedArrayBuffer(HEADER + OUT_CAP + ERR_CAP);
    const head = new Int32Array(shared, 0, 4);
    const data = Buffer.from(shared);
    let settled = false;
    let timer = null;
    let worker = null;
    const finish = (status, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ok = status === 'ok' && head[2] === 0; // an overflowed capture is a failed check, not a truncated answer
      done({
        name: check.name,
        status: ok ? 'ok' : 'failed',
        reason: ok ? undefined : status === 'ok' ? 'output overflow' : status,
        code,
        stdout: ok ? data.toString('utf8', HEADER, HEADER + head[0]) : '',
        stderr: ok ? data.toString('utf8', HEADER + OUT_CAP, HEADER + OUT_CAP + head[1]) : '',
      });
    };
    try {
      worker = new Worker(fileURLToPath(import.meta.url), {
        workerData: { acBashDispatch: 1, script: check.script, args: check.args, payload: payload, shared },
        stdout: true, stderr: true, // nothing a worker prints reaches the real stdout: the capture is the only channel
      });
    } catch { finish('spawn-error', 1); return; }
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on('error', () => { /* the 'exit' event follows */ });
    worker.on('exit', (c) => finish('ok', c));
    timer = setTimeout(() => {
      finish('timeout', null);
      worker.terminate().catch(() => {});
    }, check.timeoutMs);
    if (timer.unref) timer.unref();
  });
}

// payload: the hook's stdin text. checks: defaults to CHECKS; a test passes its own. Returns { code, stdout, stderr, results }.
export async function dispatch(payload, checks = CHECKS) {
  const results = await Promise.all(checks.map((c) => runCheck(c, payload)));
  return { ...mergeResults(results), results };
}

function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  let lastProgress = Date.now();
  let nap = null;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
      lastProgress = Date.now();
    } catch (e) {
      if (!e || (e.code !== 'EAGAIN' && e.code !== 'EWOULDBLOCK')) break;
      if (Date.now() - lastProgress > 5000) break;
      if (!nap) nap = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(nap, 0, 0, 2);
    }
  }
}

async function main() {
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch { /* no stdin: every check sees an empty payload, as it would alone */ }
  const r = await dispatch(payload);
  try {
    if (r.stdout) writeAll(1, r.stdout);
    if (r.stderr) writeAll(2, r.stderr);
  } catch { /* fail open */ }
  process.exit(r.code);
}

// Named by file name, not by path comparison: a drive-letter case or a junction in the path must never turn the entry into a silent no-op.
if (isMainThread && basename(process.argv[1] || '') === 'bash-dispatch.mjs') {
  main().catch(() => process.exit(0));
}
