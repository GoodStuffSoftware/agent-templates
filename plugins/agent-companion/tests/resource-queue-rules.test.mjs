// scripts/lib/resource-rules.mjs and the pure parts of scripts/resource-queue.mjs: rules loading
// and merging, RAM sizes, limits and verdicts, the clears log, the activity probe, the stray scan,
// request building, command planning, the re-entrancy subtraction and the stable launcher.
// No lease is taken here; the one spawn is the launcher's no-plugin fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadRules, capacityOf, parseRam, limitsFor, liveVerdict, appendClear, recentClears, clearsFile, sampleTree, scanStrays, descendants,
} from '../scripts/lib/resource-rules.mjs';
import {
  parseResourceArg, buildRequest, subtractHeld, planCommand, installLauncher, launcherPath, LAUNCHER_SOURCE,
} from '../scripts/resource-queue.mjs';

const tmp = (p = 'rq-rules-') => mkdtempSync(join(tmpdir(), p));
const rm = (d) => rmSync(d, { recursive: true, force: true });
const shipped = () => loadRules({ AC_RESOURCE_RULES: join(tmpdir(), 'rq-no-such-rules.json'), CLAUDE_CONFIG_DIR: join(tmpdir(), 'rq-no-such-dir') });

// ---------------------------------------------------------------- rules file

test('the shipped rules name every measured class with a box size, RAM and a hold limit', () => {
  const r = shipped();
  const ids = r.classes.map((c) => c.id).sort();
  assert.deepEqual(ids, ['e2e', 'e2e-spec', 'emulator', 'fs-emulator', 'gradle', 'install', 'lint', 'node-test-full', 'push-gate', 'vitest-dir', 'vitest-full']);
  for (const c of r.classes) {
    assert.ok(c.box >= 1, `${c.id} box`);
    assert.ok(c.ramMb > 0, `${c.id} ramMb`);
    assert.ok(c.maxHoldMs > 0, `${c.id} maxHoldMs`);
  }
  assert.deepEqual(r.classes.find((c) => c.id === 'e2e').resources, { 'app-e2e': 1 });
  assert.equal(r.resources['app-e2e'].capacity, 1);
  assert.ok(r.rules.find((x) => x.id === 'max-hold').enabled);
  assert.ok(r.rules.find((x) => x.id === 'idle').enabled);
  assert.deepEqual(r.legacyLocks, [], 'no global yield file ships: it is read-only config the operator adds');
});

test('a user rules file merges over the shipped one: objects key by key, classes and rules by id', () => {
  const d = tmp();
  try {
    const file = join(d, 'user.json');
    writeFileSync(file, JSON.stringify({
      ram: { reserveMb: 5000 },
      resources: { 'app-e2e': { capacity: 3 }, mine: { capacity: 2 } },
      classes: [{ id: 'lint', box: 1 }, { id: 'custom', box: 2, ramMb: 100 }],
      rules: [{ id: 'idle', enabled: false }],
    }));
    const r = loadRules({ AC_RESOURCE_RULES: file });
    assert.equal(r.ram.reserveMb, 5000);
    assert.equal(r.ram.rampMs, 60_000, 'keys the user did not set stay');
    assert.equal(r.resources['app-e2e'].capacity, 3);
    assert.equal(r.resources['app-e2e'].maxHoldMs, 900_000, 'merged key by key');
    assert.equal(r.resources.mine.capacity, 2);
    const lint = r.classes.find((c) => c.id === 'lint');
    assert.equal(lint.box, 1);
    assert.equal(lint.ramMb, 2000, 'a class merges by id');
    assert.ok(r.classes.find((c) => c.id === 'custom'));
    assert.equal(r.classes.length, shipped().classes.length + 1);
    const idle = r.rules.find((x) => x.id === 'idle');
    assert.equal(idle.enabled, false);
    assert.equal(idle.minCpuPct, 5, 'a rule merges by id');
  } finally { rm(d); }
});

test('a missing or broken user file is ignored, and the claude dir path is the default location', () => {
  const d = tmp();
  try {
    const file = join(d, 'broken.json');
    writeFileSync(file, '{ nope');
    assert.deepEqual(loadRules({ AC_RESOURCE_RULES: file }), shipped());
    mkdirSync(join(d, 'agent-companion', 'config'), { recursive: true });
    writeFileSync(join(d, 'agent-companion', 'config', 'resource-rules.json'), JSON.stringify({ resources: { viaDir: { capacity: 4 } } }));
    assert.equal(loadRules({ CLAUDE_CONFIG_DIR: d }).resources.viaDir.capacity, 4);
  } finally { rm(d); }
});

test('capacityOf: rules, then CI_BUDGET_RESOURCES, default 1, bad values ignored', () => {
  const rules = { resources: { a: { capacity: 3 }, bad: { capacity: 0 }, frac: { capacity: 1.5 } } };
  assert.equal(capacityOf(rules, {}, 'a'), 3);
  assert.equal(capacityOf(rules, { CI_BUDGET_RESOURCES: 'a=2, b=4' }, 'a'), 2, 'the env wins');
  assert.equal(capacityOf(rules, { CI_BUDGET_RESOURCES: 'a=2, b=4' }, 'b'), 4);
  assert.equal(capacityOf(rules, {}, 'unknown'), 1);
  assert.equal(capacityOf(rules, {}, 'bad'), 1);
  assert.equal(capacityOf(rules, {}, 'frac'), 1);
  assert.equal(capacityOf(rules, { CI_BUDGET_RESOURCES: 'a=0,junk,=3' }, 'a'), 3);
});

test('parseRam reads 512M, 4G, 1.5G, a bare number of MB, and rejects the rest', () => {
  assert.equal(parseRam('512M'), 512);
  assert.equal(parseRam('4G'), 4096);
  assert.equal(parseRam('4gb'), 4096);
  assert.equal(parseRam('1.5G'), 1536);
  assert.equal(parseRam('4096'), 4096);
  assert.equal(parseRam('1T'), 1024 * 1024);
  assert.equal(parseRam('2048K'), 2);
  assert.equal(parseRam(''), null);
  assert.equal(parseRam('lots'), null);
  assert.equal(parseRam('-4G'), null);
  assert.equal(parseRam(undefined), null);
});

// ---------------------------------------------------------------- limits and verdicts

test('limitsFor: the lease own limits win, else the smallest limit over the resources it holds', () => {
  const rules = { resources: { box: { maxHoldMs: 900 }, x: { maxHoldMs: 500, idleMs: 70 }, y: { maxHoldMs: 800 } } };
  assert.deepEqual(limitsFor(rules, { limits: { maxHoldMs: 10 }, units: 1, resources: { x: 1 } }), { maxHoldMs: 10, idleMs: 70, minHoldMs: null });
  assert.equal(limitsFor(rules, { units: 2, resources: { x: 1, y: 1 } }).maxHoldMs, 500);
  assert.equal(limitsFor(rules, { units: 2, resources: { y: 1 } }).maxHoldMs, 800);
  assert.equal(limitsFor(rules, { units: 0, resources: { y: 1 } }).maxHoldMs, 800, 'box counts only when units are held');
  assert.equal(limitsFor(rules, { units: 2, resources: {} }).maxHoldMs, 900);
  assert.equal(limitsFor(rules, { units: 0, resources: {} }).maxHoldMs, null);
});

test('liveVerdict: max-hold wins over idle, both apply to runs only, and a disabled rule is off', () => {
  const rules = { rules: [{ id: 'max-hold', enabled: true }, { id: 'idle', enabled: true, sampleMs: 30_000 }], resources: {} };
  const lease = (extra) => ({ kind: 'run', startedAt: 1000, units: 1, resources: {}, limits: { maxHoldMs: 100_000, idleMs: 50_000, minHoldMs: 20_000 }, ...extra });
  assert.equal(liveVerdict(rules, lease(), 90_000), null);
  assert.equal(liveVerdict(rules, lease(), 101_001).rule, 'max-hold');
  const act = { sampledAt: 90_000, activeAt: 10_000 };
  assert.equal(liveVerdict(rules, lease({ act }), 90_000).rule, 'idle');
  assert.equal(liveVerdict(rules, lease({ act }), 101_001).rule, 'max-hold', 'max-hold is checked first');
  assert.equal(liveVerdict(rules, lease({ act, kind: 'full' }), 101_001), null, 'ci-local leases are not run leases');
  assert.equal(liveVerdict({ ...rules, rules: [{ id: 'idle', enabled: false }] }, lease({ act }), 90_000), null);
  assert.equal(liveVerdict(rules, lease({ act: { sampledAt: 1000, activeAt: 1000 } }), 95_000), null, 'a probe older than 90 s says nothing');
});

// ---------------------------------------------------------------- clears log

test('the clears log appends one line per clear, rotates over 512 KB, and reads newest first within a window', () => {
  const d = tmp();
  try {
    const now = Date.now();
    appendClear(d, { at: now - 3 * 3600_000, rule: 'old', type: 'lease', id: 'a' });
    appendClear(d, { at: now - 2000, rule: 'pid-dead', type: 'lease', id: 'b' });
    appendClear(d, { at: now - 1000, rule: 'max-hold', type: 'lease', id: 'c' });
    appendFileSync(clearsFile(d), 'torn {\n');
    assert.deepEqual(recentClears(d, { now }).map((r) => r.id), ['c', 'b', 'a']);
    assert.deepEqual(recentClears(d, { now, limit: 2 }).map((r) => r.id), ['c', 'b']);
    assert.deepEqual(recentClears(d, { now, sinceMs: 3600_000 }).map((r) => r.id), ['c', 'b'], 'older than the window is left out');
    assert.deepEqual(recentClears(join(d, 'nope'), { now }), []);
    writeFileSync(clearsFile(d), 'x'.repeat(520 * 1024));
    appendClear(d, { at: now, rule: 'idle', type: 'lease', id: 'z' });
    assert.ok(existsSync(`${clearsFile(d)}.1`), 'the full log moved aside');
    assert.deepEqual(recentClears(d, { now }).map((r) => r.id), ['z']);
    assert.doesNotThrow(() => appendClear(join(d, 'clears.jsonl', 'not-a-dir'), { id: 'q' }), 'a log failure never throws');
  } finally { rm(d); }
});

// ---------------------------------------------------------------- activity probe

const proc = (pid, ppid, name, cpuMs, cmd = name) => ({ pid, ppid, name, cmd, cpuMs, startedAt: null });

test('sampleTree: active on cpu use, on a busy child, or on a listening port; never on a root alone at rest', () => {
  const table = (rows) => () => rows;
  const rows = [proc(10, 1, 'node', 1000), proc(11, 10, 'sh', 500), proc(12, 11, 'worker', 500)];
  const first = sampleTree(10, { now: 0, table: table(rows) });
  assert.equal(first.cpuMs, 2000, 'the root and every descendant');
  assert.equal(first.active, false, 'no previous sample: no cpu verdict yet');
  const idle = sampleTree(10, { prev: first, now: 30_000, table: table(rows) });
  assert.equal(idle.active, false);
  const busyRows = [proc(10, 1, 'node', 1000), proc(11, 10, 'sh', 500), proc(12, 11, 'worker', 500 + 3000)];
  const busy = sampleTree(10, { prev: first, now: 30_000, table: table(busyRows) }); // 3000 ms over 30 s = 10%
  assert.equal(busy.active, true);
  assert.match(busy.why, /^cpu 10\.0%/);
  assert.equal(sampleTree(10, { prev: first, now: 30_000, minCpuPct: 20, table: table(busyRows) }).active, false);

  const withJava = [...rows, proc(13, 12, 'java.exe', 0)];
  const child = sampleTree(10, { prev: first, now: 30_000, busyChildren: ['java'], table: table(withJava) });
  assert.equal(child.why, 'child java.exe');
  const stranger = [...rows, proc(99, 1, 'java.exe', 0)]; // not in the tree
  assert.equal(sampleTree(10, { prev: first, now: 30_000, busyChildren: ['java'], table: table(stranger) }).active, false);

  const ports = sampleTree(10, {
    prev: first, now: 30_000, ports: [[9100, 9103]], table: table(rows), listen: () => [{ port: 9101, pid: 12 }],
  });
  assert.equal(ports.why, 'listening on 9101');
  const outside = sampleTree(10, { prev: first, now: 30_000, ports: [[9100, 9103]], table: table(rows), listen: () => [{ port: 9101, pid: 99 }, { port: 5000, pid: 12 }] });
  assert.equal(outside.active, false, 'a port of another process, or outside the bands, is not activity');
  assert.equal(sampleTree(10, { table: () => null }), null, 'an unreadable process table is "unknown", never idle');
});

test('descendants walks the whole tree once, even with a cycle', () => {
  const t = [proc(1, 0, 'a', 0), proc(2, 1, 'b', 0), proc(3, 2, 'c', 0), proc(4, 3, 'd', 0), proc(1, 4, 'loop', 0), proc(9, 8, 'other', 0)];
  assert.deepEqual(descendants(t, 1).map((p) => p.pid).sort(), [2, 3, 4]);
});

test('scanStrays reports matching processes while nothing holds the resource, orphans flagged', () => {
  const rules = { strays: [
    { resource: 'app-e2e', name: 'java', cmdlineMatch: 'firestore|emulator', why: 'emulator JVM' },
    { resource: 'app-e2e', name: 'chrome-headless-shell', cmdlineMatch: '.', why: 'browser' },
  ] };
  const table = () => [
    proc(1, 0, 'init', 0), proc(50, 1, 'java.exe', 0, 'java -jar firestore-emulator.jar'), proc(51, 777, 'java.exe', 0, 'java -jar other.jar'),
    proc(52, 777, 'chrome-headless-shell.exe', 0, 'chrome-headless-shell --x'),
  ];
  const out = scanStrays(rules, new Set(), { table });
  assert.deepEqual(out.map((s) => s.pid), [50, 52]);
  assert.equal(out.find((s) => s.pid === 50).orphan, false);
  assert.equal(out.find((s) => s.pid === 52).orphan, true, 'its parent 777 is not in the table');
  assert.deepEqual(scanStrays(rules, new Set(['app-e2e']), { table }), [], 'held: not a stray');
  assert.equal(scanStrays(rules, new Set(), { table: () => null }), null);
});

// ---------------------------------------------------------------- request

test('parseResourceArg: name, name:N, box:N; rejects bad names and counts', () => {
  assert.deepEqual(parseResourceArg('box:8'), { name: 'box', units: 8 });
  assert.deepEqual(parseResourceArg('app-e2e'), { name: 'app-e2e', units: 1 });
  assert.deepEqual(parseResourceArg('pool:2'), { name: 'pool', units: 2 });
  for (const bad of ['', ':3', 'a b', 'x:0', 'x:-1', 'x:1.5', 'x:y', '../etc', 'a:1:2']) assert.throws(() => parseResourceArg(bad), /bad --resource/, bad);
});

test('buildRequest: a class supplies defaults, explicit flags override, {cwd} is a stable hash, nothing to wait for is an error', () => {
  const rules = shipped();
  const e2e = buildRequest({ cls: 'e2e' }, rules);
  assert.equal(e2e.box, 8);
  assert.deepEqual(e2e.resources, { 'app-e2e': 1 });
  assert.equal(e2e.ramMb, 5000);
  assert.equal(e2e.limits.maxHoldMs, 720_000);
  assert.ok(e2e.probe.ports.length > 0);
  assert.equal(e2e.monitored, true, 'app-e2e has an idleMs, so the lease is probed');

  const over = buildRequest({ cls: 'e2e', resources: [{ name: 'box', units: 2 }, { name: 'extra', units: 1 }], ram: 100 }, rules);
  assert.equal(over.box, 2);
  assert.deepEqual(over.resources, { 'app-e2e': 1, extra: 1 });
  assert.equal(over.ramMb, 100);

  const lint = buildRequest({ cls: 'lint' }, rules);
  assert.equal(lint.monitored, false, 'no idle limit anywhere: never probed');
  const g1 = buildRequest({ cls: 'gradle' }, rules, { cwd: '/some/project' });
  const g2 = buildRequest({ cls: 'gradle' }, rules, { cwd: '/some/project' });
  const g3 = buildRequest({ cls: 'gradle' }, rules, { cwd: '/other/project' });
  assert.deepEqual(g1.resources, g2.resources);
  assert.notDeepEqual(g1.resources, g3.resources);
  assert.match(Object.keys(g1.resources)[0], /^gradle-[0-9a-f]{8}$/);

  assert.throws(() => buildRequest({ cls: 'nope' }, rules), /unknown --class "nope"/);
  assert.throws(() => buildRequest({}, rules), /nothing to wait for/);
});

test('subtractHeld: what an ancestor lease holds is not asked for twice', () => {
  const req = { box: 4, resources: { a: 1, b: 1 }, ramMb: 1000, limits: {}, monitored: false, probe: {} };
  assert.equal(subtractHeld(req, { box: 4, resources: { a: 1, b: 1 }, ramMb: 1000 }), null, 'all covered');
  assert.equal(subtractHeld(req, { box: 8, resources: { a: 2, b: 1 }, ramMb: 0 }) !== null, false, 'bigger holdings cover too');
  const part = subtractHeld(req, { box: 4, resources: { a: 1 }, ramMb: 1000 });
  assert.equal(part.box, 0);
  assert.deepEqual(part.resources, { b: 1 });
  const small = subtractHeld(req, { box: 2, resources: {}, ramMb: 0 });
  assert.equal(small.box, 4, 'a smaller hold does not cover a bigger ask');
  assert.deepEqual(req.resources, { a: 1, b: 1 }, 'the request object is not mutated');
});

// ---------------------------------------------------------------- command planning

test('planCommand: several arguments are an exact argv, one argument with shell syntax is a command line for a shell', () => {
  const env = { ...process.env };
  const argv = planCommand([process.execPath, 'script.mjs', 'a b', 'c"d', '$HOME', '&&'], env);
  assert.equal(argv.mode, 'argv');
  assert.equal(argv.file, process.execPath);
  assert.deepEqual(argv.args, ['script.mjs', 'a b', 'c"d', '$HOME', '&&'], 'untouched: no shell, no re-quoting');
  assert.equal(planCommand(['node'], env).mode, 'argv', 'a single plain word is a program');
  const lone = planCommand([process.execPath], env);
  assert.equal(lone.mode, 'argv', 'a lone path that is a file is a program even with spaces or backslashes in it');
  assert.equal(lone.file, process.execPath);
  for (const line of ['echo "a && b" | cat', 'npm test && npm run lint', 'cd "x y"; ls', 'echo $HOME', 'a > b']) {
    const p = planCommand([line], env);
    assert.equal(p.mode, 'shell', line);
    assert.equal(p.args.at(-1), line, 'the line goes to the shell as one argument');
    assert.equal(p.args.at(-2), '-c');
  }
});

test('planCommand: Git Bash from CLAUDE_CODE_GIT_BASH_PATH is the shell on Windows', { skip: process.platform !== 'win32' }, () => {
  const p = planCommand(['echo a | cat'], { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: process.execPath });
  assert.equal(p.file, process.execPath, 'an existing configured path is used as is');
  assert.deepEqual(p.args, ['-c', 'echo a | cat']);
});

test('planCommand: a .cmd or .bat on Windows goes through cmd.exe with quoting; a bare name is resolved on PATH', { skip: process.platform !== 'win32' }, () => {
  const d = tmp('rq cmd ');
  try {
    writeFileSync(join(d, 'tool.cmd'), '@echo off\r\n');
    const env = { ...process.env, PATH: `${d};${dirname(process.execPath)};${process.env.PATH}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const p = planCommand(['tool', 'one two', 'x"y'], env);
    assert.equal(p.mode, 'cmd');
    assert.equal(p.verbatim, true);
    assert.deepEqual(p.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(p.args[3], /^"".*tool\.cmd" "one two" "x""y""$/i, 'the command line, wrapped once more for cmd /s');
    const node = planCommand(['node', '-v'], env);
    assert.equal(node.mode, 'argv');
    assert.match(node.file, /node\.exe$/i);
  } finally { rm(d); }
});

// ---------------------------------------------------------------- stable launcher

test('installLauncher writes the stable launcher once, rewrites a changed one, and reports failure', () => {
  const d = tmp();
  try {
    const env = { CLAUDE_CONFIG_DIR: d };
    const path = launcherPath(env);
    assert.equal(path, join(d, 'agent-companion', 'bin', 'resource-queue.mjs'));
    assert.equal(installLauncher(env), 'written');
    assert.equal(readFileSync(path, 'utf8'), LAUNCHER_SOURCE);
    assert.equal(installLauncher(env), 'current', 'idempotent');
    writeFileSync(path, '// edited');
    assert.equal(installLauncher(env), 'written', 'an out-of-date copy is replaced');
    assert.equal(readFileSync(path, 'utf8'), LAUNCHER_SOURCE);
    const file = join(d, 'blocker');
    writeFileSync(file, 'x');
    assert.equal(installLauncher({ CLAUDE_CONFIG_DIR: join(file, 'sub') }), 'failed', 'never throws');
  } finally { rm(d); }
});

test('the launcher picks the newest installed plugin copy by numeric version and calls its cli()', () => {
  const d = tmp();
  try {
    for (const v of ['0.9.0', '0.31.4', '0.31.24', '0.4.99']) {
      const dir = join(d, 'plugins', 'cache', 'mk', 'agent-companion', v, 'scripts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'resource-queue.mjs'), `export async function cli(argv) { console.log(${JSON.stringify(v)} + ' ' + argv.join(',')); return 5; }\n`);
    }
    const env = { CLAUDE_CONFIG_DIR: d };
    installLauncher(env);
    const r = spawnSync(process.execPath, [launcherPath(env), 'status', '--json'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
    assert.equal(r.stdout.trim(), '0.31.24 status,--json', '0.31.24 beats 0.9.0 (numeric, not text, order)');
    assert.equal(r.status, 5, "the cli() result is the exit code");
  } finally { rm(d); }
});

test('with no plugin installed the launcher still runs the command, unqueued, and keeps its exit code', () => {
  const d = tmp();
  try {
    const env = { CLAUDE_CONFIG_DIR: d };
    installLauncher(env);
    const r = spawnSync(process.execPath, [launcherPath(env), 'run', '--resource', 'box:2', '--', process.execPath, '-e', 'console.log("ran"); process.exit(6)'], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env },
    });
    assert.equal(r.status, 6);
    assert.match(r.stdout, /ran/);
    assert.match(r.stderr, /not installed; running the command without the queue/);
    const bad = spawnSync(process.execPath, [launcherPath(env), 'status'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
    assert.equal(bad.status, 1);
  } finally { rm(d); }
});
