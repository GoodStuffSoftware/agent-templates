// Scout hand-off review fixes (0.31.28 review, part 2): an ack with no readable
// expiry expires, an ack does not outlive its signal, the triage line is quiet on
// compact and worded as information, damaged ledger or state files do not silence
// the line or crash the CLI, an unreadable ledger is backed up before it is
// replaced, parallel adds keep every ack, empty flag values are errors, and a
// renewal ignores the case of --match. Every test uses a temporary state dir.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeFixture, runHook, childEnv, PLUGIN_ROOT } from './helpers.mjs';
import {
  emptyAcks, addAck, evaluate, ackIsExpired, recordRun, readState, readAcks, writeAcks, paths, applyRun, emptyState,
} from '../scripts/lib/scout-handoff.mjs';

const DAY = 86400000;
const T0 = Date.parse('2026-10-10T08:00:00Z');
const iso = (n) => new Date(T0 + n * DAY).toISOString();
const sig = (kind, detail = 'd', dispatch = 'routing-review') => ({ kind, detail, dispatch });
const CLI = join(PLUGIN_ROOT, 'scripts', 'scout-ack.mjs');

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { windowsHide: true, encoding: 'utf8', env: childEnv({}), timeout: 20000 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function cliAsync(args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { windowsHide: true, env: childEnv({}), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (status) => resolve({ status, err }));
  });
}

// ---------- P2-2: no readable expiry = expired ----------------------------------

test('an ack with a missing, null or unparseable expires is expired and the signal shows again', () => {
  const nowMs = Date.parse('2100-01-01T00:00:00Z');
  for (const expires of [undefined, null, 'garbage', '']) {
    const ack = { id: 'a1', kind: 'k', note: 'n', snapshot: { count: 1, details: ['d'] }, ...(expires === undefined ? {} : { expires }) };
    assert.equal(ackIsExpired(ack, nowMs), true, `expires ${JSON.stringify(expires)}`);
  }
  assert.equal(ackIsExpired(null, nowMs), true);
  assert.equal(ackIsExpired({ expires: new Date(nowMs + DAY).toISOString() }, nowMs), false, 'a valid future expiry holds');
  const state = applyRun(emptyState(), { checkedAt: new Date(nowMs).toISOString(), signals: [sig('k', 'alpha')] }).state;
  const view = evaluate(state, { acks: [{ id: 'a1', kind: 'k', note: 'n', snapshot: { count: 1, details: ['alpha'] } }] }, { nowMs });
  assert.deepEqual(view.unacknowledged.map((u) => u.kind), ['k']);
  assert.deepEqual(view.acknowledged, []);
});

// ---------- P2-3: an ack does not outlive its signal ----------------------------

test('a cleared signal drops its acks, so a return for a new version pair shows again', () => {
  const dir = join(makeFixtureDir(), 'state');
  const ver = (a, b) => sig('plugin_version_behind', `installed at ${a}; the latest available is ${b}`);
  recordRun(dir, { checkedAt: iso(0), signals: [ver('0.31.27', '0.31.28'), sig('other', 'unrelated')] }, { nowMs: T0 });
  const st0 = readState(dir);
  const pre = addAck(readAcks(dir), { kind: 'plugin_version_behind', note: 'later', expires: new Date(T0 + 14 * DAY).toISOString(), kinds: st0.kinds, nowMs: T0 });
  const pre2 = addAck(pre.acks, { kind: 'never_fired', note: 'pre-ack', expires: new Date(T0 + 14 * DAY).toISOString(), kinds: st0.kinds, nowMs: T0 });
  writeAcks(dir, pre2.acks);

  // day 1: the kind is gone
  recordRun(dir, { checkedAt: iso(1), signals: [sig('other', 'unrelated')] }, { nowMs: T0 + DAY });
  assert.deepEqual(readAcks(dir).acks.map((a) => a.kind), ['never_fired'], 'only the cleared kind loses its ack');

  // day 4: it returns with a new version pair
  const view = recordRun(dir, { checkedAt: iso(4), signals: [ver('0.31.28', '0.31.29'), sig('other', 'unrelated')] }, { nowMs: T0 + 4 * DAY });
  assert.ok(view.unacknowledged.some((u) => u.kind === 'plugin_version_behind'), 'shows again');
  assert.ok(!view.acknowledged.some((a) => a.kind === 'plugin_version_behind'));
});

let fixtureDirs = [];
function makeFixtureDir() {
  const fx = makeFixture();
  fixtureDirs.push(fx);
  mkdirSync(join(fx.stateDir, 'state'), { recursive: true });
  return fx.stateDir;
}
test.after(() => { for (const fx of fixtureDirs.reverse()) fx.cleanup(); });

// ---------- P2-1: the SessionStart line -----------------------------------------

function surfaceWorld() {
  const fx = makeFixture();
  const sdir = join(fx.stateDir, 'state');
  mkdirSync(sdir, { recursive: true });
  const now = Date.now();
  const rows = [3, 2, 1, 0].map((n) => ({
    checkedAt: new Date(now - n * DAY).toISOString(),
    signals: [sig('session_churn', '25 lead session-days crossed a threshold'), sig('haiku_fit_leak', '30 spawns routed to haiku ran on sonnet')],
  }));
  writeFileSync(join(sdir, 'scout-history.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileSync(join(sdir, 'scout-latest.json'), JSON.stringify(rows[3]));
  recordRun(sdir, rows[3]);
  const cwd = join(fx.dir, 'repo', '.claude', 'worktrees', 'w1');
  mkdirSync(cwd, { recursive: true });
  const env = { CLAUDE_PLUGIN_OPTION_SCOUT_TRIAGE_CWDS: join(fx.dir, 'repo').replace(/\\/g, '/') };
  return { ...fx, sdir, cwd, env };
}
const ctxOf = (res) => res.json?.hookSpecificOutput?.additionalContext || '';

test('triage line: not re-emitted on a compact start; shown on startup; worded as information; shorter than before', () => {
  const w = surfaceWorld();
  try {
    const compact = runHook('hooks/scout-surface.mjs', { session_id: 's1', cwd: w.cwd, source: 'compact' }, { cwd: w.cwd, env: w.env });
    assert.equal(compact.status, 0, compact.stderr);
    assert.equal(compact.stdout.trim(), '', 'nothing on compact');

    const start = runHook('hooks/scout-surface.mjs', { session_id: 's2', cwd: w.cwd, source: 'startup' }, { cwd: w.cwd, env: w.env });
    const ctx = ctxOf(start);
    const lines = ctx.split('\n');
    assert.match(lines[0], /Scout triage: 2 unacknowledged signal\(s\)/);
    assert.match(lines[1], /^For the plugin owner, not other tasks\. Ack: node /);
    assert.doesNotMatch(ctx, /Triage each/, 'no imperative');
    // The old second line, rebuilt with the old hint wording, was longer.
    const hint = lines[1].slice(lines[1].indexOf('Ack: ') + 5).replace('"<why>"', '"<decision>"');
    const oldLen = (lines[0] + '\n' + `Triage each (act or decide), then record it: ${hint}`).length;
    assert.ok(ctx.length < oldLen, `new ${ctx.length} < old ${oldLen}`);
  } finally { w.cleanup(); }
});

// ---------- nit 1: damaged ledger / state entries -------------------------------

test('a damaged ledger entry or state kind does not throw, silence the triage line or crash the CLI', () => {
  const w = surfaceWorld();
  try {
    writeFileSync(paths(w.sdir).acks, JSON.stringify({ acks: [null, 7, { id: 'x', kind: 'session_churn', note: 'n', expires: iso(900) }] }));
    const res = runHook('hooks/scout-surface.mjs', { session_id: 's3', cwd: w.cwd, source: 'startup' }, { cwd: w.cwd, env: w.env });
    assert.match(ctxOf(res), /Scout triage: /, 'the triage line survives a null ack');

    // an ack whose snapshot has no details
    writeFileSync(paths(w.sdir).acks, JSON.stringify({ acks: [{ id: 'y', kind: 'haiku_fit_leak', note: 'n', expires: new Date(Date.now() + DAY).toISOString(), snapshot: {} }] }));
    const res2 = runHook('hooks/scout-surface.mjs', { session_id: 's3b', cwd: w.cwd, source: 'startup' }, { cwd: w.cwd, env: w.env });
    assert.match(ctxOf(res2), /Scout triage: /);

    // the CLI still lists, shows and adds
    writeFileSync(paths(w.sdir).acks, JSON.stringify({ acks: [null] }));
    for (const args of [['list'], ['show'], ['add', 'session_churn', '--note', 'n']]) {
      const r = cli(args);
      assert.equal(r.status, 0, `${args[0]}: ${r.err}`);
    }
    // a state kind that is null: recordRun heals the file
    const st = JSON.parse(readFileSync(paths(w.sdir).state, 'utf8'));
    st.kinds.broken = null;
    st.kinds.alsoBroken = { days: 2 };
    writeFileSync(paths(w.sdir).state, JSON.stringify(st));
    const view = recordRun(w.sdir, { checkedAt: new Date().toISOString(), signals: [sig('session_churn', 'x')] });
    assert.ok(view);
    assert.equal(JSON.parse(readFileSync(paths(w.sdir).state, 'utf8')).kinds.broken, undefined, 'the broken kind is gone from the rewritten state');
  } finally { w.cleanup(); }
});

// ---------- nit 2: an unreadable ledger is never overwritten without a copy ------

test('a truncated ledger is copied to scout-acks.json.bad before add replaces it; list says it cannot be read', () => {
  const dir = makeFixtureDir();
  const sdir = join(dir, 'state');
  recordRun(sdir, { checkedAt: new Date().toISOString(), signals: [sig('a', 'alpha'), sig('b', 'beta')] });
  assert.equal(cli(['add', 'a', '--note', 'one']).status, 0);
  assert.equal(cli(['add', 'b', '--note', 'two']).status, 0);
  const file = paths(sdir).acks;
  const before = readFileSync(file);
  truncateSync(file, before.length - 40);
  const truncated = readFileSync(file);

  const list = cli(['list']);
  assert.match(list.err, /cannot be read/);

  assert.equal(cli(['add', 'a', '--note', 'three']).status, 0);
  const bad = `${file}.bad`;
  assert.ok(existsSync(bad), 'the unreadable ledger was kept');
  assert.deepEqual(readFileSync(bad), truncated, 'byte for byte');
  assert.deepEqual(readAcks(sdir).acks.map((a) => a.kind), ['a']);
});

// ---------- nit 4: two parallel adds keep both acks ------------------------------

test('parallel scout-ack add runs do not lose an ack', async () => {
  const dir = makeFixtureDir();
  const sdir = join(dir, 'state');
  const kinds = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
  recordRun(sdir, { checkedAt: new Date().toISOString(), signals: kinds.map((k) => sig(k, `detail ${k}`)) });
  for (let trial = 0; trial < 4; trial += 1) {
    writeAcks(sdir, emptyAcks());
    const results = await Promise.all(kinds.map((k) => cliAsync(['add', k, '--note', `t${trial}`])));
    for (const r of results) assert.equal(r.status, 0, r.err);
    assert.deepEqual(readAcks(sdir).acks.map((a) => a.kind).sort(), kinds, `trial ${trial}`);
  }
  assert.deepEqual(readdirSync(sdir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
});

// ---------- nit 6: empty flag values -----------------------------------------------

test('empty --expires, --match and --days values are usage errors and write nothing', () => {
  const dir = makeFixtureDir();
  const sdir = join(dir, 'state');
  recordRun(sdir, { checkedAt: new Date().toISOString(), signals: [sig('a', 'alpha')] });
  for (const args of [
    ['add', 'a', '--note', 'n', '--expires', ''],
    ['add', 'a', '--note', 'n', '--expires'],
    ['add', 'a', '--note', 'n', '--match', ''],
    ['add', 'a', '--note', 'n', '--days', ''],
    ['add', 'a', '--note', 'n', '--days'],
  ]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${JSON.stringify(args)} -> ${r.status} ${r.err}`);
    assert.match(r.err, /needs a value/);
  }
  assert.equal(existsSync(paths(sdir).acks), false, 'no ack was written');
  assert.equal(cli(['add', 'a', '--note', 'n', '--match', 'alp']).status, 0, 'a real value still works');
});

// ---------- nit 9: renewal ignores the case of --match ----------------------------------

test('a renewal on the same kind and --match in a different case replaces the ack', () => {
  const kinds = applyRun(emptyState(), { checkedAt: iso(0), signals: [sig('a', 'alpha one')] }).state.kinds;
  const exp = new Date(Date.now() + DAY).toISOString();
  const first = addAck(emptyAcks(), { kind: 'a', match: 'alpha', note: 'n', expires: exp, kinds, nowMs: T0 });
  const second = addAck(first.acks, { kind: 'a', match: 'ALPHA', note: 'n2', expires: exp, kinds, nowMs: T0 + 1000 });
  assert.equal(second.acks.acks.length, 1);
  assert.equal(second.acks.acks[0].note, 'n2');
});
