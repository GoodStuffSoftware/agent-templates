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
import { join, dirname, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadRules, capacityOf, parseRam, limitsFor, liveVerdict, appendClear, recentClears, clearsFile, sampleTree, scanStrays, descendants,
  parseMsysPs, holdsExclusive, msysLinks, msysBinCandidates, exeDir, isBusyChild, processTable,
} from '../scripts/lib/resource-rules.mjs';
import {
  runUnderQueue, parseResourceArg, buildRequest, subtractHeld, planCommand, installLauncher, launcherPath, LAUNCHER_SOURCE,
} from '../scripts/resource-queue.mjs';

const tmp = (p = 'rq-rules-') => mkdtempSync(join(tmpdir(), p));
const rm = (d) => rmSync(d, { recursive: true, force: true });
// Git for Windows' sh.exe, or null, found where the probe looks (never the caller's PATH alone).
function gitSh() {
  if (process.platform !== 'win32') return null;
  for (const d of msysBinCandidates(process.env)) {
    const p = join(d, 'sh.exe');
    if (existsSync(p) && existsSync(join(d, 'msys-2.0.dll'))) return p;
  }
  return null;
}
// Why the real msys process-tree test cannot run here, or false when it can.
const machineTreeSkip = process.platform !== 'win32' ? 'Windows only: msys process chains'
  : !gitSh() ? 'no Git for Windows sh.exe found'
    : msysLinks() === null ? 'the probe cannot find or read Git\'s ps.exe' : false;
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
    assert.equal(r.resources['app-e2e'].maxHoldMs, 1_800_000, 'merged key by key');
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
  assert.deepEqual(descendants(t, 1, [{ pid: 9, ppid: 3 }]).map((p) => p.pid).sort(), [2, 3, 4, 9], 'an extra link adopts a subtree');
});

// The 0.31.25 incident shape: wrapper -> git -> pre-push sh, whose fork + exec of an msys
// program (an npm/npx shim's bash) leaves that program with a dead Windows parent. The
// wrapper's direct tree is quiet; all the work sits under the orphaned bash.
const prePush = (busyCpu) => [
  proc(100, 1, 'node.exe', 200, 'node resource-queue.mjs run --class push-gate -- git push'),
  proc(101, 100, 'git.exe', 50), proc(102, 101, 'sh.exe', 30, 'C:\\Program Files\\Git\\usr\\bin\\sh.exe .husky/pre-push'),
  proc(200, 199, 'bash.exe', 20, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe /c/nvm4w/nodejs/npm run test:e2e'), // 199 is dead
  proc(201, 200, 'node.exe', 100, 'node npm-cli.js run test:e2e'),
  proc(202, 201, 'node.exe', busyCpu, 'node playwright/cli.js test'),
  proc(203, 202, 'java.exe', 0, 'java -jar cloud-firestore-emulator.jar'),
];
const msysPs = [
  '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
  '      500       1     500        102  ?         197611 07:37:44 /usr/bin/sh',
  '      501     500     500        200  ?         197611 07:37:45 /usr/bin/bash',
  '      502     501     500        201  ?         197611 07:37:45 /c/nvm4w/nodejs/node',
  ' S    503       1     503        999  ?         197611 07:37:45 /usr/bin/sleep',
].join('\n');

test('parseMsysPs maps msys parent pids to Windows pids, status letters and unknown parents included', () => {
  assert.deepEqual(parseMsysPs(msysPs), [{ pid: 200, ppid: 102 }, { pid: 201, ppid: 200 }]);
  assert.deepEqual(parseMsysPs(''), []);
});

test('sampleTree: a pre-push tree with a quiet wrapper and git but busy grandchildren is active (msys links)', () => {
  const links = () => parseMsysPs(msysPs);
  const first = sampleTree(100, { now: 0, table: () => prePush(1000), msys: links });
  assert.equal(first.size, 7, 'the orphaned bash and everything under it are in the tree');
  const s = sampleTree(100, { prev: first, now: 30_000, table: () => prePush(1000 + 15_000), msys: links });
  assert.equal(s.active, true);
  assert.match(s.why, /^cpu 50\.0%/);
  const child = sampleTree(100, { prev: first, now: 30_000, table: () => prePush(1000), msys: links, busyChildren: ['java'] });
  assert.equal(child.why, 'child java.exe', 'a heavy-class descendant is activity even at rest');
  const port = sampleTree(100, { prev: first, now: 30_000, table: () => prePush(1000), msys: links, ports: [[18080, 18999]], listen: () => [{ port: 18080, pid: 203 }] });
  assert.equal(port.why, 'listening on 18080');
  // Without the links the old walk sees only wrapper, git and sh: the 0.31.25 bug.
  const blind = sampleTree(100, { prev: first, now: 30_000, table: () => prePush(1000 + 15_000), msys: () => [] });
  assert.equal(blind.size, 3);
  assert.equal(blind.active, false, 'the Windows walk alone cannot see the orphaned work (why the links exist)');
});

test('sampleTree reads msys links only for a tree with an msys process, beside its own sh; no ps.exe found is "unknown"', () => {
  const calls = [];
  const spy = (o) => { calls.push(o); return parseMsysPs(msysPs); };
  sampleTree(100, { now: 0, table: () => prePush(1000), msys: spy });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].near, ['C:\\Program Files\\Git\\usr\\bin'], 'the ps.exe beside the tree\'s own sh is tried first');
  const plain = [proc(10, 1, 'node.exe', 0), proc(11, 10, 'node.exe', 0)];
  sampleTree(10, { now: 0, table: () => plain, msys: spy });
  assert.equal(calls.length, 1, 'no msys process in the tree: no spawn');
  if (process.platform === 'win32') {
    const nowhere = { PATH: '', ProgramFiles: join(tmpdir(), 'rq-no-git-here') };
    assert.equal(msysLinks({ env: nowhere, near: [], gitExecPath: () => null }), null, 'no ps.exe anywhere: unknown, not "no links"');
  } else assert.deepEqual(msysLinks({ env: { PATH: '' } }), []);
});

test('exeDir and msysLinks do not depend on the host: Windows command lines split on a Linux host too, and off Windows there are no links', () => {
  // Process command lines are Windows paths. The 0.31.26 CI failure: the host's dirname returned '.'
  // for a backslash path on Linux. posix.dirname is that Linux behaviour, run here on any host.
  const sh = String.raw`C:\Program Files\Git\usr\bin\sh.exe`;
  const bin = String.raw`C:\Program Files\Git\usr\bin`;
  assert.equal(posix.dirname(sh), '.', 'the Linux host dirname does not split a backslash path (the bug)');
  assert.equal(exeDir({ cmd: sh + ' .husky/pre-push' }), bin);
  assert.equal(exeDir({ cmd: '"' + sh + '" -c x' }), bin, 'quoted');
  assert.equal(exeDir({ cmd: 'C:/Git/usr/bin/bash.exe /c/x' }), 'C:/Git/usr/bin', 'forward slashes');
  assert.equal(exeDir({ cmd: 'bash.exe -c x' }), null, 'a bare program name has no directory');
  assert.equal(exeDir({}), null);
  // The Linux branch, injected so it also runs on Windows: no msys there, so no links, no spawn.
  assert.deepEqual(msysLinks({ platform: 'linux', env: { PATH: '' } }), []);
  assert.deepEqual(msysLinks({ platform: 'darwin' }), []);
});

test('msysBinCandidates: the tree\'s own dirs, then CLAUDE_CODE_GIT_BASH_PATH\'s install, then the standard dirs (a default when the env names none), then PATH', { skip: process.platform !== 'win32' && 'Windows paths' }, () => {
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Tools\\Git\\bin\\bash.exe', ProgramFiles: 'E:\\PF', PATH: 'F:\\x;G:\\y' };
  const c = msysBinCandidates(env, ['N:\\near']);
  assert.equal(c[0], 'N:\\near');
  assert.equal(c[1], join('D:\\Tools\\Git\\bin'));
  assert.equal(c[2], join('D:\\Tools\\Git\\usr\\bin'), '<Git>\\bin\\bash.exe -> <Git>\\usr\\bin');
  assert.equal(c[3], join('E:\\PF', 'Git', 'usr', 'bin'));
  assert.deepEqual(c.slice(-2), ['F:\\x', 'G:\\y'], 'PATH last: another msys on PATH cannot see Git Bash\'s processes');
  assert.ok(msysBinCandidates({}).includes(join('C:\\Program Files', 'Git', 'usr', 'bin')), 'a stripped env still tries the standard install');
});

test('msysLinks finds Git\'s ps.exe in a stripped environment (no PATH, no ProgramFiles): standard dir or git --exec-path', { skip: machineTreeSkip }, () => {
  const links = msysLinks({ env: {} });
  assert.ok(Array.isArray(links), 'empty env: still readable');
  const viaGit = msysLinks({ env: { PATH: '', ProgramFiles: join(tmpdir(), 'rq-no-git-here') } });
  assert.ok(Array.isArray(viaGit), 'no install dir and no PATH: git --exec-path finds it');
});

test('sampleTree: a broken parent chain is "unknown", so active; a genuinely idle tree is idle', () => {
  const first = sampleTree(100, { now: 0, table: () => prePush(1000), msys: () => null });
  const s = sampleTree(100, { prev: first, now: 30_000, table: () => prePush(1000), msys: () => null });
  assert.equal(s.active, true);
  assert.match(s.why, /^unknown/);
  const quiet = [proc(100, 1, 'node.exe', 200), proc(101, 100, 'git.exe', 50), proc(102, 101, 'sh.exe', 30)];
  const q1 = sampleTree(100, { now: 0, table: () => quiet, msys: () => [] });
  const q2 = sampleTree(100, { prev: q1, now: 30_000, table: () => quiet, msys: () => [], busyChildren: ['java'], ports: [[9100, 9103]], listen: () => [] });
  assert.equal(q2.active, false, 'readable chain, no cpu, no heavy child, no port: idle');
});

test('sampleTree: an orphan of a pid seen in an earlier sample stays in the tree, and an exited process cannot mask the rest', () => {
  const t1 = [proc(10, 1, 'node', 100), proc(11, 10, 'cmd.exe', 10), proc(12, 11, 'node', 1000)];
  const first = sampleTree(10, { now: 0, table: () => t1 });
  const t2 = [proc(10, 1, 'node', 100), proc(12, 11, 'node', 1000 + 3000)]; // 11 exited; 12 kept working
  const s = sampleTree(10, { prev: first, now: 30_000, table: () => t2 });
  assert.equal(s.size, 2);
  assert.equal(s.active, true, '3000 ms over 30 s from the adopted orphan');
  // A big exited process no longer drags the sum negative.
  const t3 = [proc(10, 1, 'node', 100), proc(11, 10, 'x', 50_000), proc(12, 10, 'y', 0)];
  const a = sampleTree(10, { now: 0, table: () => t3 });
  const b = sampleTree(10, { prev: a, now: 30_000, table: () => [proc(10, 1, 'node', 100), proc(12, 10, 'y', 3000)] });
  assert.equal(b.active, true);
});

const procAt = (pid, ppid, name, cpuMs, startedAt, cmd = name) => ({ pid, ppid, name, cmd, cpuMs, startedAt });

test('sampleTree: an orphan whose start time shows a reused pid is kept out of the tree; real orphans and unknown start times still join', () => {
  const S = 1_000_000;
  // Pid 11 (started S+1000) is in the tree at the first sample, then exits.
  const t1 = [procAt(10, 1, 'node', 100, S), procAt(11, 10, 'cmd.exe', 10, S + 1000), procAt(12, 11, 'node', 1000, S + 2000)];
  const first = sampleTree(10, { now: S + 5000, table: () => t1 });
  assert.equal(first.size, 3);
  assert.equal(first.born[11], S + 1000, 'the start of each tree pid is remembered');
  // Pid 11 is gone. 12 is its real orphan (started while 11 lived). 40 has ppid 11 but started
  // long before 11 did (its real parent was an earlier holder of the pid). 41 started after the
  // first sample found 11 dead (its parent is a later holder of the pid).
  const t2 = [
    procAt(10, 1, 'node', 100, S), procAt(12, 11, 'node', 1000 + 3000, S + 2000),
    procAt(40, 11, 'node', 9000, S - 600_000), procAt(41, 11, 'node', 9000, S + 20_000),
  ];
  const s = sampleTree(10, { prev: first, now: S + 10_000, table: () => t2 });
  assert.deepEqual(s.cpu, { 10: 100, 12: 4000 }, 'the real orphan joined; the reused-pid strangers did not');
  assert.equal(s.size, 2);
  assert.equal(s.gone[11], S + 10_000, 'the first sample that found the pid dead is remembered');
  // A later sample keeps the same window: 42 starts after pid 11 was first found dead.
  const t3 = [...t2, procAt(42, 11, 'node', 9000, S + 30_000)];
  const s3 = sampleTree(10, { prev: s, now: S + 40_000, table: () => t3 });
  assert.equal(s3.size, 2);
  assert.equal(s3.gone[11], S + 10_000, 'the death time is not moved by later samples');
  // No start time on either side is no evidence: the orphan is adopted as before (keep).
  const u1 = [procAt(10, 1, 'node', 100, null), procAt(11, 10, 'cmd.exe', 10, null)];
  const uFirst = sampleTree(10, { now: 0, table: () => u1 });
  const u2 = [procAt(10, 1, 'node', 100, null), procAt(40, 11, 'node', 9000, 5_000)];
  assert.equal(sampleTree(10, { prev: uFirst, now: 30_000, table: () => u2 }).size, 2, 'the dead pid has no recorded start and neither has the root: adopt');
  const u3 = [procAt(10, 1, 'node', 100, null), procAt(40, 11, 'node', 9000, null)];
  assert.equal(sampleTree(10, { prev: uFirst, now: 30_000, table: () => u3 }).size, 2, 'no start time on the orphan: adopt');
});

test('sampleTree: a pid that dies and is reused by a later tree member does not keep a stale death time that hides its later orphan', () => {
  const S = 1_000_000;
  const s1 = sampleTree(10, { now: S + 5000, table: () => [procAt(10, 1, 'node', 100, S), procAt(11, 10, 'cmd.exe', 10, S + 1000)] });
  const s2 = sampleTree(10, { prev: s1, now: S + 10_000, table: () => [procAt(10, 1, 'node', 100, S)] });
  assert.equal(s2.gone[11], S + 10_000);
  // Pid 11 is reused by a later member that spawns a long-lived child 13 (started after the first death).
  const s3 = sampleTree(10, { prev: s2, now: S + 40_000, table: () => [procAt(10, 1, 'node', 100, S), procAt(11, 10, 'cmd.exe', 10, S + 35_000), procAt(13, 11, 'node', 500, S + 36_000)] });
  assert.equal(s3.size, 3);
  assert.equal(s3.gone[11], undefined, 'a pid that is alive again has no death time');
  // The reused 11 exits, leaving 13 an orphan of a tree member: still ours, and its work counts.
  const s4 = sampleTree(10, { prev: s3, now: S + 70_000, table: () => [procAt(10, 1, 'node', 100, S), procAt(13, 11, 'node', 500 + 29_000, S + 36_000)] });
  assert.equal(s4.size, 2);
  assert.equal(s4.active, true);
  assert.match(s4.why, /^cpu/);
});

test('sampleTree: a known orphan stays a member when its parent pid is reused by a later tree member; a stranger and a different process do not', () => {
  const S = 1_000_000;
  const t1 = [procAt(10, 1, 'node', 100, S), procAt(11, 10, 'cmd.exe', 10, S + 1000), procAt(12, 11, 'node', 1000, S + 2000)];
  const s1 = sampleTree(10, { now: S + 5000, table: () => t1 });
  const s2 = sampleTree(10, { prev: s1, now: S + 10_000, table: () => [procAt(10, 1, 'node', 100, S), procAt(12, 11, 'node', 5000, S + 2000)] });
  assert.equal(s2.size, 2, '12 is an orphan of the exited 11');
  // 11 is reused by a later member (starts after 12): 12 now looks older than its "parent".
  const t3 = [procAt(10, 1, 'node', 100, S), procAt(11, 10, 'cmd.exe', 10, S + 35_000), procAt(12, 11, 'node', 31_000, S + 2000)];
  const s3 = sampleTree(10, { prev: s2, now: S + 40_000, table: () => t3 });
  assert.ok(s3.cpu[12] !== undefined, 'the already-adopted 12 is re-adopted');
  assert.equal(s3.size, 3);
  assert.equal(s3.active, true, '26000 ms over 30 s from 12');
  // A pid we saw whose recorded start differs now is another process: not re-adopted.
  const t4 = [procAt(10, 1, 'node', 100, S), procAt(11, 10, 'cmd.exe', 10, S + 35_000), procAt(12, 11, 'node', 31_000, S - 900_000)];
  const s4 = sampleTree(10, { prev: s2, now: S + 40_000, table: () => t4 });
  assert.equal(s4.cpu[12], undefined, 'a different incarnation of a seen pid stays out');
  // A never-seen process older than its parent stays out as before.
  const t5 = [...t3.slice(0, 2), procAt(77, 11, 'node', 9000, S - 600_000)];
  assert.equal(sampleTree(10, { prev: s2, now: S + 40_000, table: () => t5 }).cpu[77], undefined);
});

test('descendants and sampleTree: a live child older than its parent is a stale ppid after a pid reuse, not a member', () => {
  const S = 5_000_000;
  const table = [procAt(10, 1, 'node', 0, S), procAt(11, 10, 'sh', 0, S + 1000), procAt(50, 11, 'java', 0, S - 900_000), procAt(51, 11, 'java', 0, S + 2000), procAt(52, 11, 'java', 0, null)];
  assert.deepEqual(descendants(table, 10).map((p) => p.pid).sort(), [11, 51, 52], 'pid 50 predates its parent');
  // Clock slack: a child a second before its parent's recorded start is still a child.
  assert.equal(descendants([procAt(10, 1, 'a', 0, S), procAt(11, 10, 'b', 0, S - 1000)], 10).length, 1);
  const s = sampleTree(10, { now: S + 5000, busyChildren: ['java'], table: () => table.filter((p) => p.pid !== 51 && p.pid !== 52) });
  assert.equal(s.active, false, 'a java that started before its parent is not the holder\'s work');
  assert.equal(sampleTree(10, { now: S + 5000, busyChildren: ['java'], table: () => table }).active, true);
});

test('processTable on Linux reads process start times', { skip: process.platform !== 'linux' && 'Linux /proc only' }, () => {
  const t = processTable();
  const me = t.find((p) => p.pid === process.pid);
  assert.ok(me && Number.isFinite(me.startedAt), 'this process has a start time');
  assert.ok(Math.abs(me.startedAt - (Date.now() - process.uptime() * 1000)) < 5000, 'within 5 s of the node start');
});

test('isBusyChild: whole tokens and path segments match; substrings of other words do not; the shipped holder lines still match', () => {
  const p = (cmd, name = 'node.exe') => ({ name, cmd });
  // Not a holder's work: a word that merely contains the name, and a git branch name.
  assert.equal(isBusyChild(p('node.exe C:\\work\\javascript-helper\\run.js'), ['java']), false, 'java in javascript');
  assert.equal(isBusyChild(p('"C:\\Git\\bin\\git.exe" push origin fix/vitest-flake', 'git.exe'), ['vitest']), false, 'a branch name');
  assert.equal(isBusyChild(p('git push origin vitest-fix', 'git.exe'), ['vitest']), false);
  assert.equal(isBusyChild(p('node app.js --vitestrc'), ['vitest']), false);
  assert.equal(isBusyChild(p('node mavitest.js'), ['vitest']), false);
  // Real holder lines (names and command lines of the shipped busy children) that match today.
  const real = [
    ['java.exe', '"C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" -Xmx512m -jar C:\\work\\.cache\\firebase\\emulators\\cloud-firestore-emulator-1.19.8.jar', 'java'],
    ['javaw.exe', 'javaw -jar emulator.jar', 'java'],
    ['java', '/usr/bin/java -jar /opt/work/.cache/firebase/emulators/x.jar', 'java'],
    ['chrome-headless-shell.exe', '"C:\\work\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1169\\chrome-win\\chrome-headless-shell.exe" --headless --remote-debugging-pipe', 'chrome-headless-shell'],
    ['chrome-headless', '/opt/work/.cache/ms-playwright/chromium_headless_shell-1169/chrome-linux/chrome-headless-shell --headless', 'chrome-headless-shell'],
    ['node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\proj\\node_modules\\playwright\\cli.js test --workers=4', 'playwright'],
    ['node.exe', 'node C:\\proj\\node_modules\\playwright-core\\lib\\server\\registry\\index.js', 'playwright'],
    ['node.exe', 'node /proj/node_modules/@playwright/test/cli.js test', 'playwright'],
    ['node.exe', 'node C:\\proj\\node_modules\\playwright\\lib\\common\\process.js', 'playwright'],
    ['chrome.exe', 'C:\\work\\AppData\\Local\\ms-playwright\\chromium-1169\\chrome-win\\chrome.exe --headless', 'playwright'],
    ['node.exe', 'node.exe C:\\proj\\node_modules\\vitest\\vitest.mjs run --reporter=dot', 'vitest'],
    ['node.exe', 'node C:\\proj\\node_modules\\vitest\\dist\\workers\\forks.js', 'vitest'],
    ['node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\proj\\node_modules\\.bin\\vitest run src/foo.test.ts', 'vitest'],
    ['node.exe', 'node /proj/node_modules/@vitest/runner/dist/index.js', 'vitest'],
    ['cmd.exe', 'C:\\Windows\\system32\\cmd.exe /d /s /c vitest run', 'vitest'],
    ['node.exe', 'npx vitest', 'vitest'],
    ['vitest.cmd', 'vitest.cmd run', 'vitest'],
    ['node.exe', 'node ./vitest.config.ts', 'vitest'],
    ['node.exe', 'JAVA -jar x.jar', 'java'],
  ];
  for (const [name, cmd, n] of real) assert.equal(isBusyChild({ name, cmd }, [n]), true, `${n} in: ${cmd}`);
  // sampleTree uses it: the branch name on a git child does not hold a lease active.
  const rows = [proc(10, 1, 'node', 0), proc(11, 10, 'git.exe', 0, 'git push origin fix/vitest-flake')];
  assert.equal(sampleTree(10, { now: 0, busyChildren: ['vitest'], table: () => rows }).active, false);
});

// Every program here is named by absolute path (this node, Git's sh): the test must not
// depend on the caller's PATH. The push gate hides every PATH dir holding a claude
// binary, which on this machine is node's own dir, so a bare `node` fails there.
test('sampleTree on this machine: wrapper -> sh -c -> msys sh script -> node -> busy node is active', { skip: machineTreeSkip }, async () => {
  const d = tmp('rq-tree-');
  try {
    const fwd = (p) => p.replace(/\\/g, '/');
    const busy = fwd(join(d, 'busy.js'));
    const started = join(d, 'started');
    writeFileSync(busy, `require('fs').writeFileSync(${JSON.stringify(started)},'');const {spawn}=require('child_process');spawn(process.execPath,['-e','const e=Date.now()+20000;while(Date.now()<e){}'],{stdio:'ignore',windowsHide:true});setTimeout(()=>{},20000);\n`);
    writeFileSync(join(d, 'inner.sh'), `"${fwd(process.execPath)}" "${busy}"\n`);
    const quiet = `const {spawn}=require('child_process');const c=spawn(${JSON.stringify(gitSh())},['-c',${JSON.stringify(`"${fwd(gitSh())}" "${fwd(join(d, 'inner.sh'))}"; echo done`)}],{stdio:'ignore',windowsHide:true});c.on('exit',()=>process.exit(0));`;
    const { spawn } = await import('node:child_process');
    const root = spawn(process.execPath, ['-e', quiet], { stdio: 'ignore', windowsHide: true });
    let ours = [];
    try {
      await new Promise((r) => setTimeout(r, 4000));
      const first = sampleTree(root.pid, { now: Date.now() });
      await new Promise((r) => setTimeout(r, 3000));
      const s = sampleTree(root.pid, { prev: first, now: Date.now() });
      assert.ok(first && s, 'process table readable');
      assert.ok(existsSync(started), 'the msys sh script started the busy node (else the tree under test never existed)');
      ours = s.seen.filter((pid) => pid !== root.pid);
      assert.equal(s.active, true, `the busy grandchild is seen (tree ${s.size}, ${s.why})`);
      assert.match(s.why, /^cpu/);
      // The same moment through the Windows parent walk alone (no links, no earlier tree): the work is invisible.
      const blind = sampleTree(root.pid, { prev: { cpu: first.cpu, at: first.at }, now: Date.now(), msys: () => [] });
      assert.equal(blind.active, false, `the plain walk misses the orphaned msys subtree (tree ${blind.size} of ${s.size})`);
    } finally {
      try { root.kill(); } catch { /* gone */ }
      for (const pid of ours) { try { process.kill(pid); } catch { /* gone */ } } // only the tree this test started
    }
  } finally { rm(d); }
});

test('liveVerdict: max-hold only flags a live holder of an exclusive resource that is active or unmeasured, and clears a measured-idle one', () => {
  const rules = { rules: [{ id: 'max-hold', enabled: true }, { id: 'idle', enabled: true, sampleMs: 30_000 }], resources: { 'app-e2e': { capacity: 1 } } };
  const lease = (extra) => ({ kind: 'run', startedAt: 1, units: 8, resources: { 'app-e2e': 1 }, limits: { maxHoldMs: 1_800_000, idleMs: 300_000, minHoldMs: 600_000 }, ...extra });
  const now = 1_900_000;
  const active = liveVerdict(rules, lease({ act: { sampledAt: now - 10_000, activeAt: now - 10_000 } }), now);
  assert.equal(active.rule, 'max-hold');
  assert.equal(active.keep, true, 'an active holder over time is flagged, never released');
  assert.equal(active.evidence.activity, 'active');
  const unmeasured = liveVerdict(rules, lease(), now);
  assert.equal(unmeasured.keep, true, 'no probe: unknown means keep');
  assert.equal(unmeasured.evidence.activity, 'unknown');
  const staleProbe = liveVerdict(rules, lease({ act: { sampledAt: now - 600_000, activeAt: 0 } }), now);
  assert.equal(staleProbe.keep, true, 'a stale probe is unknown, not idle');
  const idle = liveVerdict(rules, lease({ act: { sampledAt: now - 10_000, activeAt: now - 400_000 } }), now);
  assert.equal(idle.rule, 'max-hold');
  assert.equal(idle.keep, true, 'measured idle past the hold limit but alive: flagged, never released');
  assert.equal(idle.evidence.activity, 'idle');
  // A box-only lease (nothing exclusive) has the plain max-hold verdict: a live holder is flagged too.
  const boxOnly = liveVerdict(rules, lease({ resources: {}, act: { sampledAt: now - 10_000, activeAt: now - 10_000 } }), now);
  assert.equal(boxOnly.rule, 'max-hold');
  assert.equal(boxOnly.keep, true);
  // Only a caller that has proved the holder gone gets the plain clears.
  assert.equal(liveVerdict(rules, lease({ resources: {}, act: { sampledAt: now - 10_000, activeAt: now - 10_000 } }), now, {}, { alive: false }).keep, undefined);
  assert.equal(liveVerdict(rules, lease({ act: { sampledAt: now - 10_000, activeAt: now - 400_000 } }), now, {}, { alive: false }).keep, undefined);
  assert.equal(liveVerdict(rules, lease({ act: { sampledAt: now - 10_000, activeAt: now - 10_000 } }), now, {}, { alive: false }).keep, true, 'an active exclusive holder is kept even then');
  assert.equal(holdsExclusive(rules, lease()), true);
  assert.equal(holdsExclusive({ resources: { pool: { capacity: 3 } } }, lease({ resources: { pool: 1 } })), false);
  // CI_BUDGET_RESOURCES overrides the rules' capacity, both ways, and liveVerdict honours it.
  assert.equal(holdsExclusive(rules, lease(), { CI_BUDGET_RESOURCES: 'app-e2e=2' }), false);
  assert.equal(holdsExclusive({ resources: { pool: { capacity: 3 } } }, lease({ resources: { pool: 1 } }), { CI_BUDGET_RESOURCES: 'pool=1' }), true);
  const act = { act: { sampledAt: now - 10_000, activeAt: now - 10_000 } };
  assert.equal(liveVerdict(rules, lease(act), now, { CI_BUDGET_RESOURCES: 'app-e2e=2' }).keep, true, 'capacity 2: not exclusive, the plain max-hold verdict, flagged for a live holder');
  assert.equal(liveVerdict(rules, lease(act), now, { CI_BUDGET_RESOURCES: 'app-e2e=2' }, { alive: false }).keep, undefined, 'the same verdict clears a dead holder');
  assert.equal(liveVerdict(rules, lease(act), now, { CI_BUDGET_RESOURCES: 'app-e2e=1' }).keep, true);
  assert.equal(liveVerdict(rules, lease(act), now).keep, true, 'no env: the rules capacity');
});

test('liveVerdict idle: a live holder over idleMs on a quiet sampler is flagged keep:true with the sample evidence; a dead one gets the plain clear', () => {
  const rules = { rules: [{ id: 'max-hold', enabled: true }, { id: 'idle', enabled: true, sampleMs: 30_000 }], resources: {} };
  const ev = { n: 20, size: 5, shells: 1, links: 0, cpuMs: 3, dtMs: 30_000, pct: 0.01, kids: 0, ports: [], why: null };
  const lease = { kind: 'run', startedAt: 1, units: 1, resources: {}, limits: { maxHoldMs: 3_600_000, idleMs: 300_000, minHoldMs: 600_000 }, act: { sampledAt: 990_000, activeAt: 1, ev } };
  const now = 1_000_000;
  const live = liveVerdict(rules, lease, now);
  assert.equal(live.rule, 'idle');
  assert.equal(live.keep, true, 'a live holder is flagged, never cleared');
  assert.equal(live.evidence.idleMs, now - 1);
  assert.equal(live.evidence.idleLimitMs, 300_000);
  assert.equal(live.evidence.sampleAgeMs, 10_000);
  assert.deepEqual(live.evidence.sample, ev);
  assert.equal(liveVerdict(rules, lease, now, {}, { alive: true }).keep, true);
  const dead = liveVerdict(rules, lease, now, {}, { alive: false });
  assert.equal(dead.rule, 'idle');
  assert.equal(dead.keep, undefined);
  // No sample record (an older sidecar): the flag carries the age only.
  const bare = liveVerdict(rules, { ...lease, act: { sampledAt: 990_000, activeAt: 1 } }, now);
  assert.equal(bare.keep, true);
  assert.equal('sample' in bare.evidence, false);
  assert.equal(bare.evidence.sampleAgeMs, 10_000);
});

test('sampleTree reports its replay record: sample count, tree size, cpu delta, busy-child matches and ports checked', () => {
  const now = 100_000;
  const table = () => [
    { pid: 10, ppid: 1, name: 'node.exe', cmd: 'node.exe rq.mjs', cpuMs: 1000 },
    { pid: 11, ppid: 10, name: 'node.exe', cmd: 'node.exe job.mjs', cpuMs: 500 },
  ];
  const a = sampleTree(10, { table, now, ports: [[9000, 9100]], busyChildren: ['vitest'], listen: () => [] });
  assert.equal(a.active, false);
  assert.deepEqual(a.ev, { n: 1, size: 2, shells: 0, links: 0, cpuMs: null, dtMs: null, pct: null, kids: 0, ports: [], why: null });
  const busy = () => table().map((p) => ({ ...p, cpuMs: p.cpuMs + 900 }));
  const b = sampleTree(10, { table: busy, prev: a, now: now + 30_000, ports: [[9000, 9100]], busyChildren: ['vitest'], listen: () => [] });
  assert.equal(b.active, true);
  assert.equal(b.ev.n, 2);
  assert.equal(b.ev.cpuMs, 1800);
  assert.equal(b.ev.dtMs, 30_000);
  assert.equal(b.ev.pct, 6);
  assert.equal(b.ev.ports, null, 'ports are not read once the cpu test already says active');
  assert.match(b.ev.why, /^cpu 6\.0%/);
  const kid = () => [...table(), { pid: 12, ppid: 11, name: 'node.exe', cmd: 'node.exe node_modules/vitest/vitest.mjs run', cpuMs: 0 }];
  const c = sampleTree(10, { table: kid, prev: b, now: now + 60_000, ports: [], busyChildren: ['vitest'], listen: () => [] });
  assert.equal(c.ev.kids, 1);
  assert.equal(c.ev.size, 3);
  assert.equal(c.ev.n, 3);
  const open = sampleTree(10, { table, prev: c, now: now + 90_000, ports: [[9000, 9100]], listen: () => [{ pid: 11, port: 9050 }, { pid: 99, port: 9051 }] });
  assert.deepEqual(open.ev.ports, [9050]);
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
  assert.equal(e2e.limits.maxHoldMs, 1_800_000);
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

test('runUnderQueue hands every sample record to the lease sidecar, and a failed read leaves the sidecar alone', async () => {
  const { EventEmitter } = await import('node:events');
  const calls = [];
  const lease = { id: 'x', off: false, cleared: false, bound: false, release() {}, recordActivity: (...a) => calls.push(a) };
  const child = new EventEmitter(); child.pid = 4242; child.kill = () => {};
  const evs = [{ n: 1, size: 3 }, null, { n: 3, size: 4 }];
  let i = 0;
  const probe = () => {
    const ev = evs[Math.min(i, evs.length - 1)]; i += 1;
    return ev ? { at: 1000 * i, active: i === 3, ev } : null;
  };
  const request = { box: 1, resources: {}, ramMb: 0, limits: {}, monitored: true, probe: {} };
  setTimeout(() => child.emit('exit', 0, null), 120);
  const code = await runUnderQueue({ request, label: 't', cmd: ['x'] }, {
    env: { PATH: '' }, err: () => {}, spawn: () => child, acquire: async () => lease, probe, probeMs: 10, rules: { rules: [{ id: 'idle', sampleMs: 10 }] },
  });
  assert.equal(code, 0);
  assert.ok(calls.length >= 2, 'sampled at least twice');
  assert.deepEqual(calls[0], [1000, calls[0][1], { n: 1, size: 3 }]);
  assert.deepEqual(calls[1].slice(2), [{ n: 3, size: 4 }], 'the unreadable sample wrote nothing');
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
