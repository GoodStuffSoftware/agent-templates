// scripts/lib/reaper.mjs: fake process tables and a fake kill, so nothing here touches a real process
// (runs the same on Linux CI). One opt-in real test at the bottom (AC_REAL_REAP_TEST=1) spawns and reaps its own
// dummy processes. Spec: docs/resource-queue.md "Reaping a lease's children".

import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  planReap, reapTree, reapOrphans, recordTree, normalizePolicy, parseNever, parsePsOutput, parseWinJson,
  realKill, processSnapshot, appendReap, reapsFile, writeTree, readTree, listTrees, treeFile,
} from '../scripts/lib/reaper.mjs';
import { appendGrant, grantsFile } from '../scripts/lib/resource-rules.mjs';

const T0 = 1_700_000_000_000;
const row = (pid, ppid, name, ct, extra = {}) => ({ pid, ppid, name, exe: extra.exe ?? '', cmd: extra.cmd ?? name, creationTime: ct, memMb: extra.memMb ?? 10 });
// A fake kill that records the order and the rows it was handed.
const killer = (log, fail = new Set()) => (t) => { log.push(t.pid); return fail.has(t.pid) ? { ok: false, error: 'denied' } : { ok: true }; };
const tmp = () => mkdtempSync(join(tmpdir(), 'reaper-test-'));
const SELF = 100; // the "current process"
// Machine: explorer(1) > claude(50) > self wrapper(100) ; the wrapper's tree: 200 > 300 > 400
const base = () => [
  row(10, 0, 'explorer.exe', T0),
  row(50, 10, 'claude.exe', T0 + 1),
  row(SELF, 50, 'node.exe', T0 + 2, { cmd: 'node resource-queue.mjs run' }),
  row(200, SELF, 'cmd.exe', T0 + 10),
  row(300, 200, 'node.exe', T0 + 11),
  row(400, 300, 'node.exe', T0 + 12),
  row(900, 10, 'notepad.exe', T0 + 5), // unrelated, in no tree
];
const treeOf = (table, extra = []) => recordTree([...table, ...extra], SELF, { now: T0 + 100 });

test('recordTree records pid + creation time for every descendant, not the wrapper or strangers', () => {
  const t = treeOf(base());
  assert.deepEqual(t.root, { pid: SELF, creationTime: T0 + 2 });
  assert.deepEqual(t.procs.map((p) => [p.pid, p.creationTime]), [[200, T0 + 10], [300, T0 + 11], [400, T0 + 12]]);
});

test('recordTree keeps a reparented grandchild through the union with the previous record', () => {
  const t1 = treeOf(base());
  const later = base().filter((r) => r.pid !== 300); // parent 300 died; 400 still points at its ppid 300
  const t2 = recordTree(later, SELF, { prev: t1 });
  assert.ok(t2.procs.some((p) => p.pid === 400), 'grandchild kept');
  assert.ok(!t2.procs.some((p) => p.pid === 300), 'dead parent dropped');
});

test('only recorded processes are targets, deepest first; an unrecorded process is never touched', () => {
  const tree = treeOf(base());
  const log = [];
  const res = reapTree({ table: base(), tree, selfPid: SELF, kill: killer(log) });
  assert.deepEqual(log, [400, 300, 200], 'children before parents');
  assert.ok(!log.includes(900) && !log.includes(SELF) && !log.includes(50));
  assert.equal(res.done, true);
  assert.deepEqual(res.targets.map((t) => t.how), ['recorded', 'recorded', 'recorded']);
});

test('pid reuse: same pid with a new creation time is spared and reported stale', () => {
  const tree = treeOf(base());
  const table = base().map((r) => (r.pid === 300 ? { ...r, ppid: 10, creationTime: T0 + 99_999, name: 'chrome.exe' } : r));
  const log = [];
  const res = reapTree({ table, tree, selfPid: SELF, kill: killer(log) });
  assert.ok(!log.includes(300), 'reused pid spared');
  assert.deepEqual(res.stale, [{ pid: 300, image: 'node.exe', why: 'pid-reused' }]);
  assert.ok(log.includes(400) && log.includes(200));
});

test('a missing creation time (either side) is spared, never killed on a pid alone', () => {
  const tree = treeOf(base());
  const table = base().map((r) => (r.pid === 200 ? { ...r, creationTime: null } : r));
  const plan = planReap({ table, tree, selfPid: SELF });
  assert.ok(!plan.targets.some((t) => t.pid === 200));
  assert.equal(plan.stale.find((s) => s.pid === 200).why, 'no-creation-time');
});

test('a descendant started after recording is included only when found live under a matched process', () => {
  const tree = treeOf(base());
  const table = [...base(), row(500, 400, 'node.exe', T0 + 50), row(501, 9999, 'node.exe', T0 + 51)];
  const plan = planReap({ table, tree, selfPid: SELF });
  assert.ok(plan.targets.some((t) => t.pid === 500 && t.how === 'descendant'));
  assert.ok(!plan.targets.some((t) => t.pid === 501), 'a stray with a missing parent is not ours');
  assert.equal(plan.targets[0].pid, 500, 'deepest first');
});

test('a descendant that started BEFORE its supposed parent (pid reuse of the parent) is not linked', () => {
  const tree = treeOf(base());
  const table = [...base(), row(600, 400, 'old.exe', T0 - 5000)];
  assert.ok(!planReap({ table, tree, selfPid: SELF }).targets.some((t) => t.pid === 600));
});

const protectedCases = [
  ['StreamDeck.exe', row(210, 200, 'StreamDeck.exe', T0 + 20)],
  ['a Stream Deck plugin host (node.exe under \\Elgato\\StreamDeck\\)', row(210, 200, 'node.exe', T0 + 20, { exe: 'C:\\Users\\me\\AppData\\Roaming\\Elgato\\StreamDeck\\NodeJS\\20.8.1\\node.exe' })],
  ['the same path with forward slashes and other case', row(210, 200, 'node.exe', T0 + 20, { exe: 'c:/users/me/appdata/roaming/ELGATO/streamdeck/nodejs/node.exe' })],
  ['a Stream Deck path only in the command line', row(210, 200, 'node.exe', T0 + 20, { cmd: 'node "C:\\Users\\me\\AppData\\Roaming\\Elgato\\StreamDeck\\Plugins\\x.sdPlugin\\a.js"' })],
  ['claude.exe', row(210, 200, 'claude.exe', T0 + 20)],
  ['claude (posix name)', row(210, 200, 'claude', T0 + 20)],
  ['claude-code launched through node', row(210, 200, 'node.exe', T0 + 20, { cmd: 'node C:\\x\\node_modules\\@anthropic-ai\\claude-code\\cli.js' })],
];
for (const [label, victim] of protectedCases) {
  test(`never killed, even recorded inside the tree: ${label}`, () => {
    const withVictim = [...base(), victim];
    const tree = treeOf(withVictim);
    assert.ok(tree.procs.some((p) => p.pid === 210), 'it was recorded');
    const log = [];
    const res = reapTree({ table: withVictim, tree, selfPid: SELF, kill: killer(log) });
    assert.ok(!log.includes(210));
    assert.ok(res.spared.some((s) => s.pid === 210));
    assert.deepEqual(log, [400, 300, 200]);
  });
}

test('a process running under a protected one (Stream Deck child, claude child) is spared too', () => {
  const table = [...base(), row(210, 200, 'StreamDeck.exe', T0 + 20), row(211, 210, 'cmd.exe', T0 + 21), row(212, 211, 'node.exe', T0 + 22)];
  const plan = planReap({ table, tree: treeOf(table), selfPid: SELF });
  assert.deepEqual(plan.targets.map((t) => t.pid).sort(), [200, 300, 400]);
  assert.deepEqual(plan.spared.map((s) => s.pid).sort(), [210, 211, 212]);
  assert.match(plan.spared.find((s) => s.pid === 212).why, /^under:streamdeck/);
});

test('running as a child of StreamDeck.exe does not spare the whole tree (the walk stops at the tree root)', () => {
  const table = [row(5, 0, 'StreamDeck.exe', T0), row(SELF, 5, 'node.exe', T0 + 2), row(200, SELF, 'cmd.exe', T0 + 10)];
  const plan = planReap({ table, tree: recordTree(table, SELF), selfPid: SELF });
  assert.deepEqual(plan.targets.map((t) => t.pid), [200]);
});

test('reap_never: plain substring (case-insensitive) and /regex/ on name, exe and cmd', () => {
  const victims = [row(210, 200, 'Keepme.exe', T0 + 20), row(211, 200, 'node.exe', T0 + 21, { cmd: 'node build-watcher.js' }), row(212, 200, 'node.exe', T0 + 22, { exe: 'D:\\Tools\\Important\\node.exe' })];
  const table = [...base(), ...victims];
  const tree = treeOf(table);
  const never = parseNever('keepme, /build-w\\w+/, \\important\\');
  const plan = planReap({ table, tree, selfPid: SELF, never });
  assert.deepEqual(plan.spared.map((s) => s.pid).sort(), [210, 211, 212]);
  assert.deepEqual(plan.targets.map((t) => t.pid).sort(), [200, 300, 400]);
  assert.deepEqual(parseNever('').length, 0);
  assert.ok(parseNever('/([/').length === 1, 'a broken regex degrades to a substring, never throws');
});

test('the current process and its ancestors are never targets, even if recorded', () => {
  const table = base();
  const tree = { v: 1, root: { pid: SELF, creationTime: T0 + 2 }, procs: [10, 50, SELF, 200].map((pid) => ({ pid, creationTime: table.find((r) => r.pid === pid).creationTime, image: 'x', parentPid: 0 })) };
  const plan = planReap({ table, tree, selfPid: SELF });
  assert.deepEqual(plan.targets.map((t) => t.pid), [400, 300, 200], 'live descendants of the root only; 900, under a spared recorded ancestor, is not expanded');
  assert.deepEqual(plan.spared.map((s) => s.pid).sort((a, b) => a - b), [10, 50, SELF]);
  assert.ok(plan.spared.every((s) => s.why === 'self-or-ancestor' || s.why === 'tree-root'));
});

test('system pids and a failed kill: not done, the error is reported', () => {
  const tree = treeOf(base());
  const log = [];
  const res = reapTree({ table: base(), tree, selfPid: SELF, kill: killer(log, new Set([300])) });
  assert.equal(res.done, false);
  assert.equal(res.targets.find((t) => t.pid === 300).error, 'denied');
  const sys = { v: 1, root: { pid: 9999, creationTime: T0 }, procs: [{ pid: 4, creationTime: T0, image: 'System' }] };
  assert.equal(planReap({ table: [row(4, 0, 'System', T0)], tree: sys, selfPid: SELF }).targets.length, 0);
});

test('a kill that throws is caught and reported', () => {
  const res = reapTree({ table: base(), tree: treeOf(base()), selfPid: SELF, kill: () => { throw new Error('boom'); } });
  assert.equal(res.targets[0].error, 'boom');
  assert.equal(res.done, false);
});

test('policy on kills, dry-run plans the same and kills nothing, off does nothing at all', () => {
  const dir = tmp();
  try {
    const tree = treeOf(base());
    const log = [];
    const on = reapTree({ table: base(), tree, selfPid: SELF, policy: 'on', kill: killer(log), logDir: dir, lease: 'L1' });
    const dry = reapTree({ table: base(), tree, selfPid: SELF, policy: 'dry-run', kill: killer(log), logDir: dir, lease: 'L1' });
    const off = reapTree({ table: () => { throw new Error('off must not read the table'); }, tree, selfPid: SELF, policy: 'off', kill: killer(log), logDir: dir });
    assert.deepEqual(log, [400, 300, 200], 'only the on run killed');
    assert.deepEqual(dry.targets.map((t) => t.pid), on.targets.map((t) => t.pid), 'same plan');
    assert.ok(dry.targets.every((t) => t.ok === null));
    assert.deepEqual(off.targets, []);
    const rows = readFileSync(reapsFile(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.map((r) => r.mode), ['kill', 'kill', 'kill', 'would-kill', 'would-kill', 'would-kill']);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['creationTime', 'how', 'image', 'lease', 'memMb', 'mode', 'ok', 'parentPid', 'pid', 'ts', 'why']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('normalizePolicy: default on, known values kept, an unknown value falls to dry-run', () => {
  assert.equal(normalizePolicy(undefined), 'on');
  assert.equal(normalizePolicy(''), 'on');
  assert.equal(normalizePolicy(' OFF '), 'off');
  assert.equal(normalizePolicy('dry-run'), 'dry-run');
  assert.equal(normalizePolicy('yes please'), 'dry-run');
});

test('a null process table kills nothing', () => {
  const log = [];
  const res = reapTree({ table: () => null, tree: treeOf(base()), selfPid: SELF, kill: killer(log) });
  assert.equal(res.tableOk, false);
  assert.deepEqual(log, []);
});

// ---------------------------------------------------------------- orphan pass

const orphanSetup = (dir, id = 'dead1') => {
  const table = base();
  // the recorded wrapper (pid 700) is dead; its tree 800 > 801 lives on
  const rec = { v: 1, root: { pid: 700, creationTime: T0 + 3 }, at: T0, procs: [{ pid: 800, creationTime: T0 + 30, image: 'node.exe', parentPid: 700 }, { pid: 801, creationTime: T0 + 31, image: 'node.exe', parentPid: 800 }] };
  writeTree(dir, id, rec);
  return [...table, row(800, 700, 'node.exe', T0 + 30), row(801, 800, 'node.exe', T0 + 31)];
};

test('orphan pass: a recorded tree whose lease is gone and wrapper dead is reaped, then its file removed', () => {
  const dir = tmp();
  try {
    const table = orphanSetup(dir);
    const log = [];
    const out = reapOrphans({ dir, table, leaseExists: () => false, selfPid: SELF, kill: killer(log) });
    assert.deepEqual(log, [801, 800]);
    assert.equal(out.length, 1);
    assert.equal(existsSync(treeFile(dir, 'dead1')), false);
    assert.ok(!log.includes(900), 'the unrecorded process was never touched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan pass: a lease that still exists, or whose wrapper still runs, is not an orphan', () => {
  const dir = tmp();
  try {
    const table = orphanSetup(dir);
    const log = [];
    reapOrphans({ dir, table, leaseExists: () => true, selfPid: SELF, kill: killer(log) });
    assert.deepEqual(log, [], 'lease exists');
    const live = [...table, row(700, 10, 'node.exe', T0 + 3)];
    const out = reapOrphans({ dir, table: live, leaseExists: () => false, selfPid: SELF, kill: killer(log) });
    assert.deepEqual(log, [], 'wrapper alive: a hand-released lease leaves its process untouched');
    assert.equal(out[0].skipped, 'wrapper-running');
    assert.ok(existsSync(treeFile(dir, 'dead1')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan pass: pid reuse of the dead wrapper pid does not make the tree look alive, and reused child pids are spared', () => {
  const dir = tmp();
  try {
    const table = orphanSetup(dir).map((r) => (r.pid === 801 ? { ...r, ppid: 10, creationTime: T0 + 77_000, name: 'game.exe' } : r));
    table.push(row(700, 10, 'unrelated.exe', T0 + 88_000)); // new owner of the dead wrapper's pid
    const log = [];
    reapOrphans({ dir, table, leaseExists: () => false, selfPid: SELF, kill: killer(log) });
    assert.deepEqual(log, [800]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan pass in dry-run: would-kill rows once per tree file, nothing killed, file kept', () => {
  const dir = tmp();
  try {
    const table = orphanSetup(dir);
    const log = [];
    const args = { dir, table, leaseExists: () => false, selfPid: SELF, policy: 'dry-run', kill: killer(log) };
    reapOrphans(args);
    reapOrphans(args);
    assert.deepEqual(log, []);
    const rows = readFileSync(reapsFile(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.length, 2, 'logged once, not on the second pass');
    assert.ok(rows.every((r) => r.mode === 'would-kill' && r.why === 'orphan' && r.lease === 'dead1'));
    assert.equal(readTree(dir, 'dead1').dryLogged, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan pass: policy off does nothing; a tree with nothing alive is cleaned up; old files are dropped', () => {
  const dir = tmp();
  try {
    const table = orphanSetup(dir);
    const log = [];
    assert.deepEqual(reapOrphans({ dir, table, leaseExists: () => false, policy: 'off', kill: killer(log) }), []);
    assert.ok(existsSync(treeFile(dir, 'dead1')));
    reapOrphans({ dir, table: base(), leaseExists: () => false, kill: killer(log) }); // nothing recorded is alive
    assert.equal(existsSync(treeFile(dir, 'dead1')), false);
    // a failed kill keeps the file until it is 7 days old
    orphanSetup(dir, 'stuck');
    reapOrphans({ dir, table, leaseExists: () => false, kill: killer(log, new Set([800, 801])), now: T0 + 1000 });
    assert.ok(existsSync(treeFile(dir, 'stuck')));
    reapOrphans({ dir, table, leaseExists: () => false, kill: killer(log, new Set([800, 801])), now: T0 + 8 * 24 * 3600_000 });
    assert.equal(existsSync(treeFile(dir, 'stuck')), false);
    writeFileSync(join(dir, 'lease-junk.tree'), '{ not json');
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    utimesSync(join(dir, 'lease-junk.tree'), old, old);
    reapOrphans({ dir, table: base(), leaseExists: () => false, kill: killer(log) });
    assert.equal(existsSync(join(dir, 'lease-junk.tree')), false);
    assert.deepEqual(listTrees(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- log rotation

test('reaps.jsonl rotates at 512 KB to reaps.jsonl.1, the same way grants.jsonl does', () => {
  const dir = tmp();
  try {
    const big = 'x'.repeat(1024);
    for (let i = 0; i < 520; i += 1) { appendReap(dir, { i, pad: big }); appendGrant(dir, { i, pad: big }); }
    for (const f of [reapsFile(dir), grantsFile(dir)]) {
      assert.ok(existsSync(`${f}.1`), `${f} rotated`);
      assert.ok(statSync(f).size < 600 * 1024);
      assert.ok(statSync(`${f}.1`).size > 512 * 1024);
    }
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('reaps')).sort(), ['reaps.jsonl', 'reaps.jsonl.1']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- adapters (fake spawn)

test('parseWinJson reads the Win32_Process JSON (pid, ppid, name, exe, cmd, /Date(ms)/, working set)', () => {
  const rows = parseWinJson(JSON.stringify([{ p: 5, pp: 1, n: 'node.exe', e: 'C:\\n\\node.exe', c: 'node x', w: 104857600, s: '/Date(1795312235661)/' }, { p: 6, pp: 1, n: 'System', e: null, c: null, w: null, s: null }]));
  assert.deepEqual(rows[0], { pid: 5, ppid: 1, name: 'node.exe', exe: 'C:\\n\\node.exe', cmd: 'node x', creationTime: 1795312235661, memMb: 100 });
  assert.equal(rows[1].creationTime, null);
  assert.equal(rows[1].exe, '');
});

test('parsePsOutput reads `ps -A -o pid=,ppid=,rss=,lstart=,args=` rows (padded day, args with spaces)', () => {
  const text = [
    '    1     0  11264 Sat Nov 21 09:00:01 2026 /sbin/init splash',
    ' 4242  1000 204800 Sat Nov  7 10:05:09 2026 node /srv/app/server.js --port 80',
    'garbage line',
  ].join('\n');
  const rows = parsePsOutput(text);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1].pid, rows[1].ppid, rows[1].memMb, rows[1].name, rows[1].cmd], [4242, 1000, 200, 'node', 'node /srv/app/server.js --port 80']);
  assert.equal(rows[1].creationTime, new Date(2026, 10, 7, 10, 5, 9).getTime());
  assert.equal(rows[0].exe, '/sbin/init');
});

test('processSnapshot spawns hidden and passes the ps flags / LC_ALL=C; a failing spawn gives null', () => {
  const calls = [];
  const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: '    1     0  11264 Sat Nov 21 09:00:01 2026 /sbin/init' }; };
  const rows = processSnapshot({ platform: 'linux', spawn: fake });
  assert.equal(rows.length, 1);
  assert.equal(calls[0].cmd, 'ps');
  assert.deepEqual(calls[0].args, ['-A', '-o', 'pid=,ppid=,rss=,time=,lstart=,args=']);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.env.LC_ALL, 'C');
  const w = [];
  processSnapshot({ platform: 'win32', spawn: (c, a, o) => { w.push({ c, a, o }); return { status: 0, stdout: '[]' }; } });
  assert.equal(w[0].c, 'powershell.exe');
  assert.equal(w[0].o.windowsHide, true);
  assert.match(w[0].a.at(-1), /Win32_Process/);
  assert.match(w[0].a.at(-1), /ExecutablePath/);
  assert.equal(processSnapshot({ platform: 'linux', spawn: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(processSnapshot({ platform: 'linux', spawn: () => { throw new Error('x'); } }), null);
});

test('realKill on Windows: one hidden PowerShell call that re-checks pid + creation time, stops that pid only; 128 = gone; 129 = pid reused, skipped; other exit = error', () => {
  const calls = [];
  const mk = (status) => (c, a, o) => { calls.push({ c, a, o }); return { status, stderr: 'ERROR: nope' }; };
  const t = { pid: 4321, creationTime: T0 + 77 };
  assert.deepEqual(realKill(t, { platform: 'win32', spawn: mk(0) }), { ok: true });
  assert.equal(calls[0].c, 'powershell.exe');
  assert.equal(calls[0].o.windowsHide, true);
  const script = calls[0].a.at(-1);
  assert.match(script, /Get-Process -Id 4321/);
  assert.ok(script.includes(`${T0 + 77}`), 'the recorded creation time is in the script');
  assert.ok(script.indexOf('exit 129') < script.indexOf('Stop-Process'), 'the creation-time check comes before the stop');
  assert.ok(!/taskkill|\/T\b|-IncludeChildProcess/i.test(script), 'never a tree kill');
  assert.deepEqual(realKill(t, { platform: 'win32', spawn: mk(128) }), { ok: true, gone: true });
  assert.deepEqual(realKill(t, { platform: 'win32', spawn: mk(129) }), { ok: true, gone: true, skipped: 'pid-reused' });
  assert.equal(realKill(t, { platform: 'win32', spawn: mk(130) }).ok, false, 'an unreadable start time is not killed');
  assert.equal(realKill(t, { platform: 'win32', spawn: mk(1) }).ok, false);
  assert.equal(realKill({ pid: 3, creationTime: T0 }, { platform: 'win32', spawn: mk(0) }).ok, false, 'system pids refused');
  const before = calls.length;
  assert.equal(realKill({ pid: 4321 }, { platform: 'win32', spawn: mk(0) }).ok, false, 'no creation time: never killed on a pid alone');
  assert.equal(calls.length, before, 'and nothing was spawned');
});

// ---------------------------------------------------------------- shared daemons, lease end, reparented leftovers

const daemonCases = [
  ['the Gradle daemon', 'java.exe', 'java -Xmx2g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10'],
  ['the Kotlin compile daemon', 'java.exe', 'java org.jetbrains.kotlin.daemon.KotlinCompileDaemon --daemon'],
  ['the adb server', 'adb.exe', 'adb -L tcp:5037 fork-server server --reply-fd 740'],
  ['the pm2 daemon', 'node.exe', 'node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\pm2\\lib\\Daemon.js'],
  ['an MSBuild reuse node', 'MSBuild.exe', 'C:\\Program Files\\MSBuild\\MSBuild.exe /nologo /nodemode:1 /nodeReuse:true'],
  ['the C# compiler server', 'VBCSCompiler.exe', 'VBCSCompiler.exe "-pipename:abc"'],
  ['watchman', 'watchman.exe', 'watchman --foreground'],
  ['sccache', 'sccache.exe', 'sccache.exe'],
  ['the turbo daemon', 'node.exe', 'node turbo daemon --foreground'],
  ['the git fsmonitor daemon', 'git.exe', 'git fsmonitor--daemon run'],
  ['gpg-agent', 'gpg-agent.exe', 'gpg-agent --supervised'],
  ['the emulator', 'emulator.exe', 'emulator -avd test_phone'],
];
for (const [label, name, cmd] of daemonCases) {
  test(`never reaped, even recorded in the tree and with no reap_never set: ${label}`, () => {
    const table = [...base(), row(210, 200, name, T0 + 20, { cmd }), row(211, 210, 'worker.exe', T0 + 21)];
    const tree = treeOf(table);
    assert.ok(tree.procs.some((p) => p.pid === 210));
    const log = [];
    const res = reapTree({ table, tree, selfPid: SELF, kill: killer(log) }); // never: [] on purpose
    assert.ok(!log.includes(210));
    assert.ok(!log.includes(211), 'what the daemon runs is not ours either');
    assert.match(res.spared.find((s) => s.pid === 210).why, /^daemon:/);
    assert.deepEqual(log, [400, 300, 200]);
  });
}

test('reap_never is added to the built-in daemon list, not a replacement for it', () => {
  const table = [...base(), row(210, 200, 'java.exe', T0 + 20, { cmd: 'java GradleDaemon 8.10' }), row(220, 200, 'oddserver.exe', T0 + 22)];
  const plan = planReap({ table, tree: treeOf(table), selfPid: SELF, never: parseNever('oddserver') });
  assert.deepEqual(plan.spared.map((s) => s.pid).sort(), [210, 220]);
  assert.match(plan.spared.find((s) => s.pid === 210).why, /^daemon:/);
  assert.match(plan.spared.find((s) => s.pid === 220).why, /^reap_never:oddserver/);
});

test('work a shared daemon started later for another session is not taken as a descendant', () => {
  const table = [...base(), row(210, 200, 'java.exe', T0 + 20, { cmd: 'java GradleDaemon 8.10' })];
  const tree = treeOf(table); // recorded at T0 + 100
  const later = [...table, row(230, 210, 'java.exe', T0 + 100 + 60_000), row(231, 230, 'node.exe', T0 + 100 + 61_000)];
  const plan = planReap({ table: later, tree, selfPid: SELF });
  assert.ok(!plan.targets.some((t) => t.pid === 230 || t.pid === 231));
  assert.deepEqual(plan.targets.map((t) => t.pid).sort(), [200, 300, 400]);
});

test('a live descendant created after the lease ended is spared, with its children, even under a recorded plain process', () => {
  const tree = treeOf(base()); // at = T0 + 100
  const table = [...base(), row(500, 400, 'late.exe', T0 + 100 + 5_000), row(501, 500, 'later.exe', T0 + 100 + 6_000)];
  const plan = planReap({ table, tree, selfPid: SELF });
  assert.ok(!plan.targets.some((t) => t.pid === 500 || t.pid === 501));
  assert.equal(plan.spared.find((s) => s.pid === 500).why, 'after-lease');
  // an explicit lease end from the caller wins over the tree's last tick
  const wide = planReap({ table, tree, selfPid: SELF, leaseEnd: T0 + 100 + 10_000 });
  assert.ok(wide.targets.some((t) => t.pid === 500) && wide.targets.some((t) => t.pid === 501));
  // a recorded process whose creation time is after the end is spared as well
  const early = planReap({ table: base(), tree, selfPid: SELF, leaseEnd: T0 - 5_000 });
  assert.equal(early.targets.length, 0);
  assert.equal(early.spared.find((s) => s.pid === 400).why, 'after-lease');
});

test('POSIX: a recorded leftover reparented to pid 1 (init) or a subreaper is reaped; the recorded root and unrecorded strangers are not', () => {
  const table = [
    row(1, 0, 'init', T0 - 10_000, { exe: '/sbin/init', cmd: '/sbin/init' }),
    row(2000, 1, 'systemd', T0 - 9_000, { cmd: '/usr/lib/systemd/systemd --user' }), // a subreaper
    row(SELF, 1, 'node', T0 + 2, { cmd: 'node resource-queue.mjs run' }),
    row(200, SELF, 'sh', T0 + 10), row(300, 200, 'node', T0 + 11),
    row(900, 1, 'other-session-server', T0 + 5), // unrecorded, also under init
  ];
  const tree = recordTree(table, SELF, { now: T0 + 100 });
  // the wrapper exits: 200 and 300 are reparented, one to init, one to the subreaper
  const after = [
    table[0], table[1], table[5],
    row(200, 1, 'sh', T0 + 10), row(300, 2000, 'node', T0 + 11),
    row(301, 300, 'node', T0 + 40),
  ];
  const plan = planReap({ table: after, tree, selfPid: 7777 });
  assert.deepEqual(plan.targets.map((t) => t.pid).sort((a, b) => a - b), [200, 300, 301]);
  assert.ok(!plan.spared.some((s) => /^under:/.test(s.why)), 'init and the subreaper protect nothing');
  assert.ok(!plan.targets.some((t) => t.pid === 900));
});

test('a recorded child under a recorded protected process is still spared (under:)', () => {
  const table = [...base(), row(210, 200, 'StreamDeck.exe', T0 + 20), row(211, 210, 'cmd.exe', T0 + 21)];
  const plan = planReap({ table, tree: treeOf(table), selfPid: SELF });
  assert.match(plan.spared.find((s) => s.pid === 211).why, /^under:streamdeck/);
});

test('realKill on POSIX: SIGTERM, a fresh snapshot, SIGKILL only if the same pid + creation time still runs', () => {
  const sent = [];
  const target = { pid: 4321, creationTime: T0 };
  const kill = (pid, sig) => sent.push([pid, sig]);
  const sleep = () => {};
  assert.deepEqual(realKill(target, { platform: 'linux', kill, sleep, snapshot: () => [] }), { ok: true });
  assert.deepEqual(sent, [[4321, 'SIGTERM']]);
  sent.length = 0;
  realKill(target, { platform: 'linux', kill, sleep, snapshot: () => [row(4321, 1, 'node', T0 + 9999)] }); // pid reused: no SIGKILL
  assert.deepEqual(sent, [[4321, 'SIGTERM']]);
  sent.length = 0;
  assert.equal(realKill(target, { platform: 'linux', kill, sleep, snapshot: () => [row(4321, 1, 'node', T0)] }).escalated, true);
  assert.deepEqual(sent, [[4321, 'SIGTERM'], [4321, 'SIGKILL']]);
  const esrch = () => { const e = new Error('no'); e.code = 'ESRCH'; throw e; };
  assert.deepEqual(realKill(target, { platform: 'linux', kill: esrch, sleep, snapshot: () => [] }), { ok: true, gone: true });
});

test('tree files round-trip (atomic write)', () => {
  const dir = tmp();
  try {
    const t = treeOf(base());
    assert.equal(writeTree(dir, 'abc', t), true);
    assert.deepEqual(readTree(dir, 'abc'), t);
    assert.equal(readTree(dir, 'nope'), null);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- opt-in real test

test('REAL: reaps its own spawned child + grandchild, spares an unrelated sibling (AC_REAL_REAP_TEST=1)', {
  skip: process.env.AC_REAL_REAP_TEST === '1' ? false : 'set AC_REAL_REAP_TEST=1 to spawn and reap real dummy processes',
  timeout: 90_000,
}, async () => {
  const spawned = [];
  const dir = tmp();
  const loop = 'setInterval(() => {}, 1000)';
  // C starts G and prints "ready <G pid>"; H (the stand-in wrapper) starts C and forwards its output.
  const cScript = `const {spawn}=require('child_process');const g=spawn(process.execPath,['-e',${JSON.stringify(loop)}],{windowsHide:true,stdio:'ignore'});console.log('ready '+g.pid);${loop}`;
  const hScript = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(cScript)}],{windowsHide:true,stdio:['ignore','pipe','ignore']});c.stdout.pipe(process.stdout);console.log('child '+c.pid);${loop}`;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const start = (script) => { const p = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); spawned.push(p); return p; };
  try {
    const sibling = start(loop);
    const H = start(hScript);
    const ids = await new Promise((resolve, reject) => {
      let buf = '';
      const to = setTimeout(() => reject(new Error('dummy tree did not start')), 30_000);
      H.stdout.on('data', (d) => {
        buf += d;
        const c = /child (\d+)/.exec(buf); const g = /ready (\d+)/.exec(buf);
        if (c && g) { clearTimeout(to); resolve({ c: Number(c[1]), g: Number(g[1]) }); }
      });
    });
    const table = processSnapshot();
    assert.ok(table, 'real process snapshot');
    const tree = recordTree(table, H.pid);
    const inTree = tree.procs.map((p) => p.pid);
    // On Windows each node child also owns a conhost.exe: those are tree members too and are reaped with it.
    assert.ok(inTree.includes(ids.c) && inTree.includes(ids.g), 'child + grandchild recorded');
    assert.ok(tree.procs.every((p) => /^(node|conhost)(.exe)?$/.test(p.image)), JSON.stringify(tree.procs));
    assert.ok(!tree.procs.some((p) => p.pid === sibling.pid));
    writeTree(dir, 'real', tree);
    // The wrapper (H) is "dead" for the orphan pass only if it is gone; here reap the live tree directly, as release does.
    const res = reapTree({ table: processSnapshot(), tree, selfPid: process.pid, policy: 'on', kill: (t) => realKill(t), logDir: dir, lease: 'real', why: 'release' });
    assert.deepEqual(res.targets.map((t) => t.pid).sort(), [...inTree].sort(), 'exactly the recorded tree');
    assert.ok(res.targets.every((t) => t.ok), JSON.stringify(res.targets));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(alive(ids.c), false, 'child gone');
    assert.equal(alive(ids.g), false, 'grandchild gone');
    for (const pid of inTree) assert.equal(alive(pid), false, `tree member ${pid} gone`);
    assert.equal(alive(sibling.pid), true, 'unrelated sibling alive');
    assert.equal(alive(H.pid), true, 'the wrapper itself is not a target');
    assert.ok(res.targets.findIndex((t) => t.pid === ids.g) < res.targets.findIndex((t) => t.pid === ids.c), 'grandchild killed before its parent');
  } finally {
    for (const p of spawned) { try { p.kill(); } catch { /* gone */ } } // only processes this test spawned
    rmSync(dir, { recursive: true, force: true });
  }
});
