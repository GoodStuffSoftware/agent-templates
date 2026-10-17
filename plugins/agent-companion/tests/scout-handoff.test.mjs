// Scout hand-off: the delta (new, cleared, changed, repeating), the acknowledgement
// ledger (ack, expiry, a material change re-raising), the CLI, the detect.mjs hook-in
// and the SessionStart line for a triage session versus any other session.
// Every test runs against a temporary state directory (makeFixture); none touches
// the operator's real ~/.claude/agent-companion/state.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook, childEnv, PLUGIN_ROOT } from './helpers.mjs';
import {
  applyRun, emptyState, replayHistory, evaluate, emptyAcks, addAck, removeAck, materialChange, parseExpiry,
  recordRun, readState, readAcks, writeAcks, paths, isTriageCwd, parseTriagePatterns, triageLine, normalizeDetail, similarity,
} from '../scripts/lib/scout-handoff.mjs';

const DAY = 86400000;
const T0 = Date.parse('2026-10-10T08:00:00Z');
const iso = (n) => new Date(T0 + n * DAY).toISOString();
const sig = (kind, detail = 'd', dispatch = 'routing-review') => ({ kind, detail, dispatch });
const run = (n, signals) => ({ checkedAt: iso(n), changed: signals.length > 0, signals });

function feed(runs) {
  let state = emptyState();
  let last;
  for (const r of runs) { const out = applyRun(state, r); state = out.state; last = out.delta; }
  return { state, delta: last };
}

// ---------- the delta --------------------------------------------------------

test('delta: new, cleared, changed (count / detail / numbers) and unchanged', () => {
  const { delta } = feed([
    run(0, [sig('a', 'alpha one'), sig('b', '5 spawns'), sig('c', 'gamma'), sig('d', 'delta'), sig('d', 'delta')]),
    run(1, [sig('a', 'alpha one'), sig('b', '9 spawns'), sig('c', 'something else entirely'), sig('d', 'delta'), sig('e', 'epsilon')]),
  ]);
  assert.deepEqual(delta.new.map((n) => n.kind), ['e']);
  assert.deepEqual(delta.cleared, []);
  const byKind = Object.fromEntries(delta.changed.map((c) => [c.kind, c]));
  assert.equal(byKind.b.change, 'numbers', 'only digits moved');
  assert.equal(byKind.c.change, 'detail');
  assert.equal(byKind.d.change, 'count');
  assert.deepEqual([byKind.d.from, byKind.d.to], [2, 1]);
  assert.equal(byKind.a, undefined, 'unchanged kinds are not in the delta');
});

test('delta: a kind that stops firing is cleared, and a return starts a new streak', () => {
  let { state, delta } = feed([run(0, [sig('a')]), run(1, [sig('a')]), run(2, [])]);
  assert.deepEqual(delta.cleared.map((c) => [c.kind, c.days]), [['a', 2]]);
  assert.equal(state.kinds.a, undefined);
  const next = applyRun(state, run(3, [sig('a')]));
  assert.equal(next.state.kinds.a.days, 1);
  assert.deepEqual(next.delta.new.map((n) => n.kind), ['a']);
});

test('delta: days repeating counts calendar days; a second run the same day adds none', () => {
  const { state } = feed([
    run(0, [sig('a')]),
    { checkedAt: new Date(T0 + 3600000).toISOString(), signals: [sig('a')] }, // same UTC day
    run(1, [sig('a')]),
    run(2, [sig('a')]),
  ]);
  assert.equal(state.kinds.a.days, 3);
  assert.equal(state.kinds.a.firstDay, '2026-10-10');
});

test('delta: repeating = threshold days or more and unacknowledged; threshold is configurable', () => {
  const { state } = feed([run(0, [sig('a'), sig('b')]), run(1, [sig('a'), sig('b')]), run(2, [sig('a'), sig('c')])]);
  assert.equal(state.kinds.a.days, 3);
  assert.equal(state.kinds.b, undefined, 'b cleared on day 2');
  const v3 = evaluate(state, emptyAcks(), { nowMs: T0 + 2 * DAY, threshold: 3 });
  assert.deepEqual(v3.repeating.map((r) => r.kind), ['a'], 'only a reached 3 days');
  const v4 = evaluate(state, emptyAcks(), { nowMs: T0 + 2 * DAY, threshold: 4 });
  assert.deepEqual(v4.repeating, [], 'threshold raised');
  const v1 = evaluate(state, emptyAcks(), { nowMs: T0 + 2 * DAY, threshold: 1 });
  assert.ok(v1.repeating.some((r) => r.kind === 'c'), 'c is on day 1');
});

test('replayHistory restores real streaks from scout-history rows', () => {
  const state = replayHistory([run(0, [sig('a')]), run(1, [sig('a')]), run(2, [sig('a'), sig('b')])]);
  assert.equal(state.kinds.a.days, 3);
  assert.equal(state.kinds.b.days, 1);
});

// ---------- the ledger -----------------------------------------------------------

function ackedWorld(extra = {}) {
  const { state } = feed([run(0, [sig('trial', 'explore trial due'), sig('trial', 'verify trial due'), sig('trial', 'operate trial due'), sig('trial', 'review trial due')]), run(1, [sig('trial', 'explore trial due'), sig('trial', 'verify trial due'), sig('trial', 'operate trial due'), sig('trial', 'review trial due')])]);
  const nowMs = T0 + DAY;
  const exp = parseExpiry(null, nowMs, { days: 10 });
  const { acks, ack } = addAck(emptyAcks(), { kind: 'trial', note: 'DECISIONS 10-17', expires: exp.iso, kinds: state.kinds, nowMs, ...extra });
  return { state, acks, ack, nowMs };
}

test('ack lifecycle: an ack hides the signal, expiry brings it back, remove deletes it', () => {
  const { state, acks, ack, nowMs } = ackedWorld();
  assert.equal(ack.snapshot.count, 4);

  const during = evaluate(state, acks, { nowMs, threshold: 1 });
  assert.equal(during.unacknowledged.length, 0, 'acknowledged');
  assert.equal(during.acknowledged[0].kind, 'trial');
  assert.equal(during.acknowledged[0].note, 'DECISIONS 10-17');
  assert.equal(during.repeating.length, 0);

  const after = evaluate(state, acks, { nowMs: Date.parse(ack.expires) + 1000, threshold: 1 });
  assert.equal(after.unacknowledged.length, 1, 'expired ack no longer counts');
  assert.equal(after.expiredAcks[0].id, ack.id);

  const { acks: gone, removed } = removeAck(acks, ack.id);
  assert.equal(removed.id, ack.id);
  assert.equal(evaluate(state, gone, { nowMs, threshold: 1 }).unacknowledged.length, 1);
  assert.equal(removeAck(gone, 'nope').removed, null);
});

test('ack with --match covers only the matching entries', () => {
  const { state, acks, nowMs } = ackedWorld({ match: 'explore' });
  const v = evaluate(state, acks, { nowMs, threshold: 1 });
  const u = v.unacknowledged.find((x) => x.kind === 'trial');
  assert.equal(u.open, 3, 'three entries still open');
  assert.equal(u.count, 4);
});

test('material change: growth re-raises (2+ more AND half again), small growth and shrinkage do not', () => {
  const { acks, ack, nowMs } = ackedWorld();
  const mk = (n) => ({ trial: { days: 3, count: n, entries: Array.from({ length: n }, (_, i) => ({ detail: ['explore trial due', 'verify trial due', 'operate trial due', 'review trial due', 'explore trial due', 'verify trial due'][i % 6], dispatch: 'x' })) } });
  assert.equal(materialChange(ack, mk(4)), false);
  assert.equal(materialChange(ack, mk(5)), false, '+1 is not material');
  assert.equal(materialChange(ack, mk(6)), true, '+2 and +50% of 4 is material');
  assert.equal(materialChange(ack, mk(2)), false, 'shrinking is improvement');
  assert.equal(materialChange(ack, { }), false, 'nothing to raise');
  // and through evaluate()
  const st = { checkedAt: iso(2), kinds: mk(6), lastRun: { new: [], cleared: [], changed: [] } };
  const v = evaluate(st, acks, { nowMs, threshold: 1 });
  assert.equal(v.unacknowledged.length, 1, 'material growth re-raises');
  assert.equal(v.reRaisedAcks[0].id, ack.id);
});

test('material change: a new kind of entry re-raises; numbers moving does not', () => {
  const kinds = { s: { days: 1, count: 1, entries: [{ detail: '462 spawns/24h; 0 unrouted premium', dispatch: 'none' }] } };
  const { ack } = addAck(emptyAcks(), { kind: 's', note: 'n', expires: iso(30), kinds, nowMs: T0 });
  const same = { s: { days: 2, count: 1, entries: [{ detail: '471 spawns/24h; 3 unrouted premium', dispatch: 'none' }] } };
  assert.equal(materialChange(ack, same), false, 'numbers moved');
  const other = { s: { days: 2, count: 1, entries: [{ detail: 'harness version changed; enforcement went silent in two projects', dispatch: 'none' }] } };
  assert.equal(materialChange(ack, other), true, 'a different sentence is a new thing');
  assert.ok(similarity(normalizeDetail('462 spawns'), normalizeDetail('9 spawns')) === 1);
});

test('parseExpiry: dates are end of day UTC, past dates and junk are refused, default is 14 days', () => {
  assert.equal(parseExpiry('2026-12-01', T0).iso, '2026-12-01T23:59:59.999Z');
  assert.ok(parseExpiry('2026-01-01', T0).error);
  assert.ok(parseExpiry('soon', T0).error);
  assert.equal(parseExpiry(null, T0).iso, new Date(T0 + 14 * DAY).toISOString());
});

// ---------- files + CLI + detect hook-in -------------------------------------------------

test('recordRun writes state, scout-delta.json and scout-delta.md in the given dir; first run replays history', () => {
  const { stateDir, cleanup } = makeFixture();
  try {
    const dir = join(stateDir, 'state');
    mkdirSync(dir, { recursive: true });
    const rows = [run(0, [sig('a', 'x')]), run(1, [sig('a', 'x')]), run(2, [sig('a', 'x'), sig('b', 'y')])];
    writeFileSync(paths(dir).history, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const view = recordRun(dir, rows[2], { nowMs: T0 + 2 * DAY });
    assert.equal(readState(dir).kinds.a.days, 3, 'streak restored from history, current row not double counted');
    assert.deepEqual(view.new.map((n) => n.kind), ['b']);
    assert.ok(existsSync(paths(dir).delta));
    const md = readFileSync(paths(dir).md, 'utf8');
    assert.match(md, /a: day 3/);
    assert.match(md, /New this run \(1\)/);
    assert.match(md, /scout-ack\.mjs|add <kind>/);
  } finally { cleanup(); }
});

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'scout-ack.mjs'), ...args], {
    windowsHide: true, encoding: 'utf8', env: childEnv(env), timeout: 20000,
  });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('scout-ack CLI: add, list, show, remove against a temporary state dir', () => {
  const { stateDir, cleanup } = makeFixture();
  try {
    const dir = join(stateDir, 'state');
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    recordRun(dir, { checkedAt: now, signals: [sig('haiku_fit_leak', '30 spawns routed to haiku ran on sonnet')] });

    assert.equal(cli(['add', 'haiku_fit_leak']).status, 2, 'note is required');
    assert.equal(cli(['add', 'haiku_fit_leak', '--note', 'x', '--expires', '2020-01-01']).status, 2, 'past expiry refused');
    const add = cli(['add', 'haiku_fit_leak', '--note', 'DECISIONS 10-17', '--days', '5']);
    assert.equal(add.status, 0, add.err);
    assert.match(add.out, /acknowledged haiku_fit_leak as a\w+ until \d{4}-\d{2}-\d{2} \(1 current entry/);

    const listed = JSON.parse(cli(['list', '--json']).out);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'active');
    assert.equal(listed[0].note, 'DECISIONS 10-17');
    assert.match(cli(['list']).out, /haiku_fit_leak .*active.*DECISIONS 10-17/);

    const md = cli(['show']).out;
    assert.match(md, /Acknowledged \(1\)/);
    assert.match(md, /Needs triage: unacknowledged \(0\)/);

    const rm = cli(['remove', listed[0].id]);
    assert.equal(rm.status, 0, rm.err);
    assert.match(cli(['show']).out, /Needs triage: unacknowledged \(1\)/);
    assert.equal(cli(['remove', 'zzz']).status, 2);
    assert.equal(cli(['bogus']).status, 2);
    assert.deepEqual(readAcks(dir).acks, []);
  } finally { cleanup(); }
});

test('detect.mjs writes the hand-off after the scout result (zero model calls)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'detect.mjs')], {
      windowsHide: true, encoding: 'utf8', cwd: dir, timeout: 120000,
      env: childEnv({ AGENT_COMPANION_DISCOVERY_NO_GH: '1', CLAUDE_PLUGIN_OPTION_RELEASE_WATCH: 'false', CLAUDE_PLUGIN_OPTION_USAGE_ANALYSIS: 'false' }),
    });
    assert.equal(r.status, 0, r.stderr);
    const sdir = join(stateDir, 'state');
    assert.ok(existsSync(join(sdir, 'scout-latest.json')));
    assert.ok(existsSync(join(sdir, 'scout-delta-state.json')), 'delta state written');
    assert.ok(existsSync(join(sdir, 'scout-delta.md')), 'delta md written');
    const latest = JSON.parse(readFileSync(join(sdir, 'scout-latest.json'), 'utf8'));
    const view = JSON.parse(readFileSync(join(sdir, 'scout-delta.json'), 'utf8'));
    assert.equal(view.checkedAt, latest.checkedAt);
  } finally { cleanup(); }
});

// ---------- triage matching + the SessionStart line --------------------------------------

test('isTriageCwd: prefix match covers worktrees; case, slashes and /c/ forms normalised; no patterns = none', () => {
  const repo = 'D:/work/team/dev/agent-templates';
  assert.equal(isTriageCwd('D:\\work\\team\\dev\\agent-templates', repo), true);
  assert.equal(isTriageCwd('d:/work/team/dev/agent-templates/.claude/worktrees/abc', repo), true);
  assert.equal(isTriageCwd('/d/work/team/dev/agent-templates/plugins/x', repo), true);
  assert.equal(isTriageCwd('D:/work/team/dev/agent-templates-other', repo), false, 'a sibling with the same prefix text');
  assert.equal(isTriageCwd('D:/work/team/dev/other', repo), false);
  assert.equal(isTriageCwd('D:/work/team/dev/other', ''), false);
  assert.equal(isTriageCwd('C:/x', undefined), false);
  assert.equal(isTriageCwd('D:/work/a b/dev/r', 'D:/work/a b/dev/r;D:/other'), true, 'spaces in a path; semicolon list');
  assert.equal(isTriageCwd('D:/work/proj-two/src', 'D:/work/proj-*'), true, 'wildcard');
  assert.deepEqual(parseTriagePatterns('a, b;c\nd'), ['a', 'b', 'c', 'd']);
});

function surfaceWorld(cwdSub) {
  const fx = makeFixture();
  const sdir = join(fx.stateDir, 'state');
  mkdirSync(sdir, { recursive: true });
  const day = (n) => new Date(Date.now() - n * DAY).toISOString();
  const rows = [3, 2, 1, 0].map((n) => ({
    checkedAt: day(n),
    signals: [
      sig('session_churn', '25 lead session-days crossed a threshold'),
      sig('haiku_fit_leak', '30 spawns routed to haiku ran on sonnet'),
      sig('spawn_activity', '462 spawns/24h', 'none'),
      sig('cli_release_available', 'Claude Code 2.1.302 is out', 'none'),
      ...(n === 0 ? [sig('plugin_copy_stale', 'a stale copy', 'manual-check')] : []),
    ],
  }));
  writeFileSync(join(sdir, 'scout-history.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(sdir, 'scout-latest.json'), JSON.stringify(rows[3]));
  recordRun(sdir, rows[3]);
  const cwd = join(fx.dir, cwdSub);
  mkdirSync(cwd, { recursive: true });
  return { ...fx, sdir, cwd };
}

test('triage session: two-line actionable line, top 3 with days repeating, pointers to the md and the ack command', () => {
  const w = surfaceWorld(join('repo', '.claude', 'worktrees', 'w1'));
  try {
    const repo = join(w.dir, 'repo').replace(/\\/g, '/');
    const res = runHook('hooks/scout-surface.mjs', { session_id: 's-t', cwd: w.cwd }, { cwd: w.cwd, env: { CLAUDE_PLUGIN_OPTION_SCOUT_TRIAGE_CWDS: repo } });
    assert.equal(res.status, 0, res.stderr);
    const ctx = res.json?.hookSpecificOutput?.additionalContext || '';
    const lines = ctx.split('\n').filter(Boolean);
    assert.ok(lines.length <= 2, `at most two lines, got ${lines.length}: ${ctx}`);
    assert.match(lines[0], /Scout triage: 4 unacknowledged signal\(s\): /);
    assert.match(lines[0], /session_churn \(day 4\)/);
    assert.match(lines[0], /haiku_fit_leak \(day 4\)/);
    assert.match(lines[0], /\+1 more/, 'the fourth is counted, not listed');
    assert.doesNotMatch(lines[0], /cli_release_available/, 'has its own line, not repeated here');
    assert.match(lines[0], /scout-delta\.md/);
    assert.match(lines[1], /scout-ack\.mjs" add <kind> --note/);
    assert.doesNotMatch(ctx, /Mention only if asked/, 'the passive line is replaced');
  } finally { w.cleanup(); }
});

test('non-triage session (default option, or a cwd outside the pattern) keeps today\'s passive line', () => {
  const w = surfaceWorld('elsewhere');
  try {
    for (const env of [{}, { CLAUDE_PLUGIN_OPTION_SCOUT_TRIAGE_CWDS: join(w.dir, 'some-other-repo').replace(/\\/g, '/') }]) {
      const res = runHook('hooks/scout-surface.mjs', { session_id: 's-n', cwd: w.cwd }, { cwd: w.cwd, env });
      assert.equal(res.status, 0, res.stderr);
      const ctx = res.json?.hookSpecificOutput?.additionalContext || '';
      assert.match(ctx, /Scout .*: 4 drift signal\(s\) \(not errors\): /);
      assert.match(ctx, /Mention only if asked about routing, models, guards or costs\./);
      assert.doesNotMatch(ctx, /Scout triage/);
    }
  } finally { w.cleanup(); }
});

test('triage session: acknowledged signals drop out of the line; all acknowledged = no scout line; no state = passive fallback', () => {
  const w = surfaceWorld('repo');
  try {
    const env = { CLAUDE_PLUGIN_OPTION_SCOUT_TRIAGE_CWDS: join(w.dir, 'repo').replace(/\\/g, '/') };
    const state = readState(w.sdir);
    let acks = emptyAcks();
    for (const kind of ['session_churn', 'spawn_activity', 'plugin_copy_stale', 'haiku_fit_leak']) {
      acks = addAck(acks, { kind, note: 'triaged', expires: new Date(Date.now() + 5 * DAY).toISOString(), kinds: state.kinds, nowMs: Date.now() }).acks;
    }
    writeAcks(w.sdir, acks);
    const res = runHook('hooks/scout-surface.mjs', { session_id: 's-a', cwd: w.cwd }, { cwd: w.cwd, env });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '', 'everything actionable is acknowledged: nothing from the scout');

    // one expired ack puts that signal back
    acks.acks[0].expires = new Date(Date.now() - DAY).toISOString();
    writeAcks(w.sdir, acks);
    const res2 = runHook('hooks/scout-surface.mjs', { session_id: 's-a2', cwd: w.cwd }, { cwd: w.cwd, env });
    const ctx2 = res2.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx2, /Scout triage: 1 unacknowledged signal\(s\): session_churn \(day 4\)/);

    // no hand-off state yet (scout ran before this feature): passive line
    writeFileSync(paths(w.sdir).state, '{}');
    const res3 = runHook('hooks/scout-surface.mjs', { session_id: 's-a3', cwd: w.cwd }, { cwd: w.cwd, env });
    assert.match(res3.json?.hookSpecificOutput?.additionalContext || '', /Mention only if asked/);
  } finally { w.cleanup(); }
});

test('triageLine: ordering puts signals with a dispatch before informational ones, then longest streak', () => {
  const view = { unacknowledged: [], };
  assert.equal(triageLine(view, { mdPath: 'p', ackHint: 'h' }), null);
  const { state } = feed([
    run(0, [sig('info', 'i', 'none'), sig('act', 'a', 'routing-review')]),
    run(1, [sig('info', 'i', 'none'), sig('act', 'a', 'routing-review'), sig('act2', 'z', 'routing-review')]),
  ]);
  const v = evaluate(state, emptyAcks(), { nowMs: T0 + DAY });
  assert.deepEqual(v.unacknowledged.map((u) => u.kind), ['act', 'act2', 'info']);
});
