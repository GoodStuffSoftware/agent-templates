// The efficiency sections of the daily usage report (landings, lead compactions, Opus share and Opus-writer share, accounts,
// setting markers). Synthetic facts, git repositories and transcripts in a temp dir; invented ids and names only; no model call.
import { makeFixture } from './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  rowUnits, median, repoOf, landingRef, countLandings, landingsOf, compactionRecords, leadCompactionsOf, isWriterSpawn, opusSharesOf,
  accountsOf, markerValues, changedMarkers, computeEfficiency, handoffOf,
} from '../scripts/lib/usage/efficiency.mjs';
import { runAnalysis, readResult, efficiencyPending } from '../scripts/lib/usage/runner.mjs';
import { efficiencyLines, renderReport } from '../scripts/lib/usage/report.mjs';

const SPEC = { inUsd: 1, outRatio: 5, r: 0.1, w5: 1.25, w1: 2, mult: 1 };
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const USED = { [SONNET]: SPEC, [OPUS]: SPEC };
const zero = () => [0, 0, 0, 0, 0, 0];
const tok = (u) => [u, 0, 0, 0, 0, 1]; // u plain input units under SPEC
const FROM = Date.parse('2026-11-18T08:00:00Z');
const TO = FROM + 86400000;

const row = (hour, sid, { main = {}, sub = {}, proj = 'proj-a', cwd = null } = {}) => ({
  hour, sid, proj, cwd,
  tok: Object.fromEntries([...new Set([...Object.keys(main), ...Object.keys(sub)])].map((m) => [m, { m: main[m] ? tok(main[m]) : zero(), s: sub[m] ? tok(sub[m]) : zero() }])),
  pr: { n: 1, len: [1, 0, 0, 0], corr: 0 }, ag: 0, sm: 0, gc: 0,
});
const spawn = (id, model, units, extra = {}) => ({
  id, sid: 'sess-1', aid: `a-${id}`, proj: 'proj-a', type: null, role: 'none', rung: null, fit: null, model, mixed: false,
  start: '2026-11-18T10:00:00.000Z', end: '2026-11-18T10:10:00.000Z', partial: false, req: { n: 1, bucket: '1-5', cat: {} },
  ctx: { buckets: [tok(units), zero(), zero(), zero()], peak: 1000 }, startup: zero(), comp: { n: 0, after: null }, extraTurns: 0, status: null,
  simple: { runs: 0, req: 0, tok: zero() }, rk: { d: null, n: null, h: null }, ...extra,
});
const grow = (o) => new Map(Object.entries(o)); // tool_use_id -> spawns.jsonl row

// ---------------------------------------------------------------- opus share --

test('the 3-spawn fixture: an Opus reviewer and an Opus plan leg that wrote files, plus a Sonnet writer, give a 0% Opus-writer share', () => {
  const rows = [row('2026-11-18T10:00:00.000Z', 'sess-1', { sub: { [OPUS]: 60, [SONNET]: 40 } })];
  const spawns = [
    spawn('tu-review', OPUS, 30, { type: 'code-review', role: 'reviewer' }), // wrote REVIEW-x.md
    spawn('tu-plan', OPUS, 30, { type: 'novel-design', role: 'other' }), // wrote <task>-plan.md
    spawn('tu-write', SONNET, 40, { type: 'integration', role: 'writer' }),
  ];
  const spawnRows = grow({
    'tu-review': { declared_role: 'reviewer', declared_type: 'code-review' },
    // a plan leg without a ROLE line: the guard inserted ROLE: other (its type, novel-design, is a writing type)
    'tu-plan': { declared_role: null, declared_type: 'novel-design', silent_fixes: ['role_inserted:other'] },
    'tu-write': { declared_role: 'writer', declared_type: 'integration' },
  });
  const o = opusSharesOf({ rows, spawns, used: USED, spawnRows });
  assert.equal(o.writerPct, 0);
  assert.equal(o.writerSpawns, 0);
  assert.equal(o.opusSpawns, 2);
  assert.equal(o.subagentUnits, 100);
  assert.equal(o.opusUnits, 60);
  assert.equal(o.opusPct, 60);
});

test('an Opus spawn is a writer by declared role (writer, fixer, lander) or, with no ROLE, by a writing task type', () => {
  const sp = spawn('x', OPUS, 10);
  for (const role of ['writer', 'fixer', 'lander']) assert.equal(isWriterSpawn(sp, { declared_role: role }), true, role);
  for (const role of ['reviewer', 'docs', 'lookup', 'operate', 'other']) assert.equal(isWriterSpawn(sp, { declared_role: role, declared_type: 'integration' }), false, role);
  assert.equal(isWriterSpawn(sp, { declared_role: null, declared_type: 'bounded-feature' }), true);
  assert.equal(isWriterSpawn(sp, { declared_role: null, declared_type: 'code-review' }), false);
  assert.equal(isWriterSpawn(sp, { declared_role: null, declared_type: 'lookup' }), false);
  assert.equal(isWriterSpawn(sp, { declared_role: null, declared_type_resolved: 'integration', declared_type: 'integ' }), true);
  // no guard row at all: the role the transcript's brief carried, then the type
  assert.equal(isWriterSpawn({ ...sp, role: 'fixer' }, null), true);
  assert.equal(isWriterSpawn({ ...sp, role: 'reviewer', type: 'integration' }, null), false);
  assert.equal(isWriterSpawn({ ...sp, role: 'none', type: 'mechanical-edit' }, null), true);
  assert.equal(isWriterSpawn({ ...sp, role: 'none', type: null }, null), false);
});

test('Opus writers are counted by their own units against all subagent units; a Sonnet writer never counts', () => {
  const rows = [row('2026-11-18T10:00:00.000Z', 'sess-1', { sub: { [OPUS]: 25, [SONNET]: 75 } })];
  const spawns = [spawn('tu-a', OPUS, 25, { type: 'bounded-feature', role: 'writer' }), spawn('tu-b', SONNET, 75, { type: 'integration', role: 'writer' })];
  const o = opusSharesOf({ rows, spawns, used: USED, spawnRows: grow({ 'tu-a': { declared_role: 'fixer' }, 'tu-b': { declared_role: 'writer' } }) });
  assert.equal(o.writerPct, 25);
  assert.equal(o.opusPct, 25);
  assert.equal(o.spawnsWithoutGuardRow, 0);
  const none = opusSharesOf({ rows: [], spawns: [], used: USED });
  assert.equal(none.opusPct, null); // no subagent cost is n/a, never 0
});

// ------------------------------------------------------------------ landings --

function git(cwd, args, date) {
  return execFileSync('git', ['-c', 'user.name=Fixture Dev', '-c', 'user.email=dev@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) },
  });
}
const commit = (cwd, msg, date) => git(cwd, ['commit', '--allow-empty', '-m', msg], date);

test('landings count first-parent commits of the default branch inside the day: a merged branch is one landing, other days and other branches do not count', () => {
  const fx = makeFixture();
  try {
    const repo = join(fx.dir, 'repo-one');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    commit(repo, 'old', '2026-11-17T12:00:00Z'); // before the day
    commit(repo, 'direct landing', '2026-11-18T12:00:00Z'); // 1
    git(repo, ['switch', '-q', '-c', 'feature-x']);
    commit(repo, 'f1', '2026-11-18T13:00:00Z');
    commit(repo, 'f2', '2026-11-18T13:30:00Z');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '--no-ff', '-m', 'merge feature-x', 'feature-x'], '2026-11-18T14:00:00Z'); // 2 (the merge; f1, f2 are not landings)
    commit(repo, 'next day', '2026-11-19T09:00:00Z'); // after the day
    git(repo, ['switch', '-q', '-c', 'wip']);
    commit(repo, 'unlanded', '2026-11-18T15:00:00Z'); // on another branch: not a landing

    assert.equal(landingRef(repo).name, 'main');
    assert.equal(countLandings(repo, 'refs/heads/main', FROM, TO), 2);

    const rows = [
      row('2026-11-18T12:00:00.000Z', 'sess-1', { main: { [SONNET]: 30 }, cwd: repo }),
      row('2026-11-18T13:00:00.000Z', 'sess-2', { sub: { [SONNET]: 10 }, cwd: repo }),
      row('2026-11-18T13:00:00.000Z', 'sess-3', { main: { [SONNET]: 7 }, cwd: join(fx.dir, 'not-a-repo') }),
    ];
    const l = landingsOf({ rows, used: USED, fromMs: FROM, toMs: TO });
    assert.equal(l.repos.length, 1);
    assert.deepEqual({ ...l.repos[0] }, { label: 'repo-one', branch: 'main', sessions: 2, units: 40, landings: 2, unitsPerLanding: 20 });
    assert.equal(l.totalLandings, 2);
    assert.equal(l.unitsPerLanding, 20);
    assert.equal(l.unattributedUnits, 7);
  } finally { fx.cleanup(); }
});

test('landings: the merge target (guard.mergeTarget) replaces the default branch; a linked worktree resolves to its main repository; no landing is n/a, not 0', () => {
  const fx = makeFixture();
  try {
    const repo = join(fx.dir, 'repo-two');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    commit(repo, 'base', '2026-11-10T12:00:00Z');
    git(repo, ['branch', 'integration']);
    git(repo, ['switch', '-q', 'integration']);
    commit(repo, 'lands on the target', '2026-11-18T12:00:00Z');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['config', 'guard.mergeTarget', 'integration']);
    assert.equal(landingRef(repo).name, 'integration');
    assert.equal(countLandings(repo, landingRef(repo).ref, FROM, TO), 1);

    const wt = join(fx.dir, 'wt-two');
    git(repo, ['worktree', 'add', '-q', '-b', 'scratch', wt]);
    const viaWt = repoOf(wt);
    const viaRoot = repoOf(repo);
    assert.equal(viaWt.key, viaRoot.key);

    const quiet = landingsOf({ rows: [row('2026-11-20T12:00:00.000Z', 's', { main: { [SONNET]: 5 }, cwd: wt })], used: USED, fromMs: FROM + 2 * 86400000, toMs: TO + 2 * 86400000 });
    assert.equal(quiet.repos[0].landings, 0);
    assert.equal(quiet.repos[0].unitsPerLanding, null);
    assert.equal(quiet.unitsPerLanding, null);
  } finally { fx.cleanup(); }
});

test('landings take an injected git runner (no process spawned) and a repository whose branch is unknown says so', () => {
  const calls = [];
  const fake = (dir, args) => {
    calls.push(args[0]);
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return `${dir}/.git\n`;
    return null; // no config, no origin/HEAD, no main or master
  };
  const l = landingsOf({ rows: [row('2026-11-18T12:00:00.000Z', 's', { main: { [SONNET]: 3 }, cwd: '/fixture/repo-three' })], used: USED, fromMs: FROM, toMs: TO, git: fake });
  assert.equal(l.repos[0].branch, null);
  assert.equal(l.repos[0].landings, null);
  assert.equal(l.totalLandings, 0);
  assert.ok(calls.length > 0);
});

// -------------------------------------------------------------- compactions --

const boundary = (sid, ts, { trigger = 'auto', pre = 200000, version = '2.1.326' } = {}) => JSON.stringify({
  type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', timestamp: ts, sessionId: sid, version,
  compactMetadata: { trigger, ...(pre === null ? {} : { preTokens: pre, postTokens: 20000 }) },
});
const asst = (ts, version = '2.1.326') => JSON.stringify({ type: 'assistant', timestamp: ts, version, message: { model: OPUS, usage: { input_tokens: 1 } } });

test('lead compactions: counts and median tokens before compacting per lead session, only the day\'s records, Claude Code build from the tail', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'projects');
    mkdirSync(join(root, 'proj-a'), { recursive: true });
    writeFileSync(join(root, 'proj-a', 'sess-1.jsonl'), [
      asst('2026-11-18T09:00:00Z'),
      boundary('sess-1', '2026-11-17T23:00:00Z', { pre: 999999 }), // before the day
      boundary('sess-1', '2026-11-18T10:00:00Z', { pre: 200000 }),
      boundary('sess-1', '2026-11-18T12:00:00Z', { pre: 220000 }),
      boundary('sess-1', '2026-11-18T13:00:00Z', { pre: 240000 }),
      boundary('sess-1', '2026-11-18T14:00:00Z', { trigger: 'manual', pre: null }), // no token figure
      boundary('sess-1', '2026-11-19T09:00:00Z', { pre: 999999 }), // after the day
      asst('2026-11-19T09:30:00Z', '2.1.330'),
    ].join('\n') + '\n');
    writeFileSync(join(root, 'proj-a', 'sess-2.jsonl'), `${asst('2026-11-18T10:00:00Z')}\n`); // no compaction
    const rows = [
      row('2026-11-18T10:00:00.000Z', 'sess-1', { main: { [OPUS]: 10 } }),
      row('2026-11-18T10:00:00.000Z', 'sess-2', { main: { [OPUS]: 10 } }),
      row('2026-11-18T10:00:00.000Z', 'sess-3', { main: { [OPUS]: 10 } }), // transcript gone
      row('2026-11-18T10:00:00.000Z', 'sess-4', { sub: { [OPUS]: 10 } }), // subagent tokens only: not a lead session
    ];
    const c = leadCompactionsOf({ rows, fromMs: FROM, toMs: TO, transcriptsRoot: root });
    assert.equal(c.leadSessions, 3);
    assert.equal(c.unreadable, 1);
    assert.equal(c.sessionsWithCompaction, 1);
    assert.equal(c.total, 4);
    assert.equal(c.withoutTokenFigure, 1);
    assert.equal(c.medianPreTokens, 220000);
    assert.deepEqual(c.rows, [{ sid: 'sess-1', n: 4, auto: 3, manual: 1, medianPreTokens: 220000 }]);
    assert.deepEqual(c.versions, { '2.1.330': 1, '2.1.326': 1 });
  } finally { fx.cleanup(); }
});

test('compaction records: a torn line and a similar record of another type are ignored', () => {
  const buf = Buffer.from(`${boundary('s', '2026-11-18T10:00:00Z')}\n{"type":"user","subtype":"compact_boundary"}\n{"subtype":"compact_boundary" torn\n`);
  assert.equal(compactionRecords(buf).length, 1);
  assert.equal(median([3, 1, 2, null]), 2);
  assert.equal(median([]), null);
});

// ------------------------------------------------------------------- accounts --

test('accounts: each session-hour goes to the account active then, with that account\'s rate; one account or none is "single"', () => {
  const history = [{ at: '2026-11-18T00:00:00Z', acct: 'acct-north-one' }, { at: '2026-11-18T12:00:00Z', acct: 'acct-south-two' }];
  const rows = [
    row('2026-11-18T09:00:00.000Z', 's1', { main: { [SONNET]: 40 } }),
    row('2026-11-18T11:00:00.000Z', 's2', { main: { [SONNET]: 10 } }),
    row('2026-11-18T12:00:00.000Z', 's3', { sub: { [SONNET]: 30 } }), // the hour a switch happens in goes to the account at its start
  ];
  const rates = { 'acct-north-one': { value: 25, basis: 'account' }, 'acct-south-two': { value: 50, basis: 'plan' } };
  const a = accountsOf({ rows, used: USED, history, rateFor: (x) => rates[x] });
  assert.equal(a.single, false);
  assert.deepEqual(a.rows.map((r) => [r.account, r.units, r.unitsPerPercent, r.pctOfWeek, r.rateBasis]), [
    ['acct-nor', 50, 25, 2, 'account'],
    ['acct-sou', 30, 50, 0.6, 'plan'],
  ]);
  // before the first known account: unknown, no rate
  const early = accountsOf({ rows: [row('2026-11-17T09:00:00.000Z', 's0', { main: { [SONNET]: 5 } })], used: USED, history, rateFor: (x) => rates[x] });
  assert.deepEqual(early.rows.map((r) => [r.account, r.pctOfWeek]), [['unknown', null]]);
  for (const h of [[], null, [history[0]], [history[0], { at: '2026-11-18T05:00:00Z', acct: 'acct-north-one' }]]) assert.deepEqual(accountsOf({ rows, used: USED, history: h, rateFor: () => null }), { single: true });
  assert.deepEqual(efficiencyLines({ accounts: { single: true } }).filter((l) => /^account:/.test(l)), ['account: single']);
});

test('accounts: an hour inside a span of unknown switch time is "unattributed", given to neither account and with no rate', () => {
  const history = [
    { at: '2026-11-18T00:00:00Z', acct: 'acct-north-one' },
    { at: '2026-11-18T20:00:00Z', acct: 'acct-south-two', after: '2026-11-18T08:00:00Z' }, // seen as north at 08:00, as south at 20:00
  ];
  const rows = [
    row('2026-11-18T07:00:00.000Z', 's1', { main: { [SONNET]: 40 } }),
    row('2026-11-18T12:00:00.000Z', 's2', { main: { [SONNET]: 10 } }), // inside the unknown span
    row('2026-11-18T21:00:00.000Z', 's3', { sub: { [SONNET]: 30 } }),
  ];
  const a = accountsOf({ rows, used: USED, history, rateFor: () => ({ value: 10, basis: 'account' }) });
  assert.deepEqual(a.rows.map((r) => [r.account, r.units, r.pctOfWeek]), [['acct-nor', 40, 4], ['acct-sou', 30, 3], ['unattributed', 10, null]]);
  assert.match(efficiencyLines({ accounts: a }).join('\n'), /\| unattributed \| 10 \| n\/a \| n\/a \(switch time unknown\) \|/);
});

// ------------------------------------------------------------------- markers --

test('markers: the four values, and the ones that differ from the previous day are the changed ones', () => {
  const cur = markerValues({ cc: { '2.1.326': 3 }, guardVersions: { '0.31.58': 4 }, pluginVersion: '9.9.9', window: 250000, floor: 0 });
  assert.deepEqual(cur, { claudeCode: '2.1.326', agentCompanion: '0.31.58', autoCompactWindow: '250000', mainCompactFloorTokens: '0 (off)' });
  const mixed = markerValues({ cc: { '2.1.326': 3, '2.1.314': 1 }, guardVersions: {}, pluginVersion: '0.31.58', window: null, floor: 367000 });
  assert.equal(mixed.claudeCode, '2.1.326 (3), 2.1.314 (1)');
  assert.equal(mixed.agentCompanion, '0.31.58');
  assert.equal(mixed.autoCompactWindow, 'default');
  assert.deepEqual(changedMarkers(cur, mixed), { claudeCode: '2.1.326', autoCompactWindow: '250000', mainCompactFloorTokens: '0 (off)' });
  assert.deepEqual(changedMarkers(null, mixed), {});
  assert.deepEqual(changedMarkers(cur, cur), {});
});

test('markers already stored for a day are kept on a recompute (today\'s settings are not stamped on an old day)', () => {
  const facts = { weightsUsed: USED, rows: [], spawns: [] };
  const first = computeEfficiency({ f: facts, fromMs: FROM, toMs: TO, seams: { transcriptsRoot: null, settings: () => ({ window: 250000, floor: 0 }), pluginVersion: '0.31.58', nowT: TO + 3600000 } });
  assert.equal(first.markers.values.autoCompactWindow, '250000');
  assert.equal(first.markers.late, false);
  const again = computeEfficiency({ f: facts, fromMs: FROM, toMs: TO, seams: { transcriptsRoot: null, settings: () => ({ window: 183000, floor: 400000 }), pluginVersion: '0.31.99', prior: first.markers, nowT: TO + 9e9 } });
  assert.deepEqual(again.markers.values, first.markers.values);
  const late = computeEfficiency({ f: facts, fromMs: FROM, toMs: TO, seams: { transcriptsRoot: null, settings: () => ({ window: 1, floor: 0 }), nowT: TO + 5 * 86400000 } });
  assert.equal(late.markers.late, true);
  assert.match(efficiencyLines(late).join('\n'), /read when this report was computed/);
});

test('a part that fails says why and does not stop the others', () => {
  const eff = computeEfficiency({ f: { weightsUsed: USED, rows: [row('2026-11-18T10:00:00.000Z', 's', { sub: { [OPUS]: 5 }, cwd: '/fixture/repo-four' })], spawns: [] }, fromMs: FROM, toMs: TO, seams: { transcriptsRoot: null, git: () => { throw new Error('boom'); } } });
  assert.match(eff.landings.gap, /boom/);
  assert.match(eff.compactions.gap, /no transcripts folder/);
  assert.equal(eff.opus.opusPct, 100);
  assert.match(efficiencyLines(eff).join('\n'), /Not measured: could not be measured: boom/);
});

// --------------------------------------------------------- through the runner --

test('the runner writes the sections into the report; the second day marks the setting that changed; a rerun is identical', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    const factsDir = join(root, 'state', 'usage-facts');
    mkdirSync(factsDir, { recursive: true });
    const days = ['2026-11-16', '2026-11-17'];
    for (const day of days) {
      const next = new Date(Date.parse(`${day}T08:00:00Z`) + 86400000).toISOString().slice(0, 10);
      writeFileSync(join(factsDir, `${day}.json`), JSON.stringify({
        schema: 'agent-companion/usage-facts', factsVersion: 1, extractorVersion: 2, day, from: `${day}T08:00:00.000Z`, to: `${next}T08:00:00.000Z`,
        dataThrough: `${next}T07:59:00.000Z`, scanFrom: `${day}T08:00:00.000Z`, computedAt: `${next}T09:00:00.000Z`, weightsUsed: USED,
        rows: [row(`${day}T10:00:00.000Z`, 'sess-1', { main: { [SONNET]: 20 }, sub: { [OPUS]: 5, [SONNET]: 15 } })],
        spawns: [spawn('tu-1', OPUS, 5, { type: 'code-review', role: 'reviewer', start: `${day}T10:00:00.000Z` })],
      }));
    }
    const settings = { window: 250000 };
    const eff = (extra = {}) => ({
      git: () => null, transcriptsRoot: join(fx.dir, 'no-transcripts'), accountHistory: [], pluginVersion: '0.31.58',
      spawnRows: grow({ 'tu-1': { declared_role: 'reviewer', guard_version: '0.31.58' } }), settings: () => ({ ...settings, floor: 0 }), ...extra,
    });
    const run = (nowT, extra = {}) => runAnalysis({ root, nowT, metrics: () => null, cwds: [], days: undefined, efficiency: eff(), ...extra });
    const r1 = run(Date.parse('2026-11-17T12:00:00Z'), { days: ['2026-11-16'] }); // the 16th is closed and settled
    assert.deepEqual(r1.computed, ['2026-11-16']);
    settings.window = 183000;
    const r2 = run(Date.parse('2026-11-18T12:00:00Z'), { days: ['2026-11-17'] });
    assert.deepEqual(r2.computed, ['2026-11-17']);
    const a = readResult(root, '2026-11-16');
    const b = readResult(root, '2026-11-17');
    assert.equal(a.efficiency.markers.values.autoCompactWindow, '250000');
    assert.deepEqual(b.efficiency.markers.changed, { autoCompactWindow: '250000' });
    assert.equal(b.efficiency.opus.writerPct, 0);
    assert.equal(b.efficiency.accounts.single, true);
    const text = renderReport(b);
    assert.match(text, /### Landings/);
    assert.match(text, /### Lead compactions/);
    assert.match(text, /\| Opus writers \| 0 \| 0% \|/);
    assert.match(text, /^account: single$/m);
    assert.match(text, /\| autoCompactWindow \| 183000 \| CHANGED \(was 250000\) \|/);
    assert.match(text, /\| main_compact_floor_tokens \| 0 \(off\) \| same \|/);
    // a forced recompute keeps the stored markers and so renders the same bytes
    settings.window = 1;
    const r3 = run(Date.parse('2026-11-18T12:00:00Z'), { days: ['2026-11-17'], force: true });
    assert.deepEqual(r3.computed, ['2026-11-17']);
    assert.equal(renderReport(readResult(root, '2026-11-17')), text);
  } finally { fx.cleanup(); }
});

test('the time budget: the efficiency parts stop at it (first day included), the day is kept, the next run completes only what was not reached', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    const factsDir = join(root, 'state', 'usage-facts');
    mkdirSync(factsDir, { recursive: true });
    const day = '2026-11-16';
    writeFileSync(join(factsDir, `${day}.json`), JSON.stringify({
      schema: 'agent-companion/usage-facts', factsVersion: 1, extractorVersion: 2, day, from: `${day}T08:00:00.000Z`, to: '2026-11-17T08:00:00.000Z',
      dataThrough: '2026-11-17T07:59:00.000Z', scanFrom: `${day}T08:00:00.000Z`, computedAt: '2026-11-17T09:00:00.000Z', weightsUsed: USED,
      rows: ['a', 'b', 'c'].map((x, i) => row(`${day}T1${i}:00:00.000Z`, `sess-${i + 1}`, { main: { [SONNET]: 20 }, cwd: `/fixture/repo-${x}` })),
      spawns: [],
    }));
    const tdir = join(fx.dir, 'transcripts');
    mkdirSync(join(tdir, 'proj-a'), { recursive: true });
    writeFileSync(join(tdir, 'proj-a', 'sess-1.jsonl'), `${boundary('sess-1', `${day}T12:00:00Z`, { pre: 150000 })}\n`);

    // a fake clock the git seam advances: 10 s per git call; a repository costs 4 calls (resolve, merge target, branch check, log)
    const clk = { t: 1000, cost: 10000, calls: 0 };
    const git = (dir, args) => {
      clk.t += clk.cost; clk.calls += 1;
      if (args.includes('--git-common-dir')) return `${dir}/.git\n`;
      if (args[0] === 'config') return 'main\n';
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'log') return '';
      return null;
    };
    const run = (extra = {}) => runAnalysis({
      root, nowT: Date.parse('2026-11-17T12:00:00Z'), metrics: () => null, cwds: [], days: [day], clock: () => clk.t,
      efficiency: { git, transcriptsRoot: tdir, accountHistory: [], pluginVersion: '0.31.58', spawnRows: new Map(), settings: () => ({ window: 250000, floor: 0 }) }, ...extra,
    });

    // run 1: a 60 s budget. The three repositories are resolved (30 s) and one is counted (30 s more); the next is not started.
    const start = clk.t;
    const r1 = run({ maxSeconds: 60 });
    assert.deepEqual(r1.computed, [day], 'the first day runs');
    assert.ok(clk.t - start <= 60000, `no overrun: ${clk.t - start} ms of a 60000 ms budget`);
    const a = readResult(root, day);
    assert.equal(a.efficiency.landings.deferred, true);
    assert.match(a.efficiency.landings.gap, /time budget/);
    assert.equal(a.efficiency.compactions.total, 1, 'the part that was reached is measured');
    assert.ok(a.totals.units > 0, 'the day itself is kept');
    assert.match(renderReport(a), /Not measured: the run time budget was used up; the next run completes this part\./);
    assert.equal(efficiencyPending(a), true);

    // a run with no budget left does not redo it (and so cannot loop); the day stays as it is
    const calls = clk.calls;
    const r0 = run({ maxSeconds: 0 });
    assert.deepEqual(r0.computed, []);
    assert.equal(clk.calls, calls, 'no git call without budget');

    // run 2: a fresh budget, cheap git. Only the landings are computed; the compactions are kept (their transcript is gone: a recompute would lose them).
    clk.cost = 1;
    rmSync(join(tdir, 'proj-a', 'sess-1.jsonl'));
    const r2 = run({ maxSeconds: 60 });
    assert.deepEqual(r2.computed, [day]);
    const b = readResult(root, day);
    assert.equal(b.efficiency.landings.gap, undefined);
    assert.equal(b.efficiency.landings.repos.length, 3);
    assert.equal(b.efficiency.compactions.total, 1, 'kept from run 1');
    assert.equal(b.revision, a.revision, 'same inputs: same revision');
    assert.equal(efficiencyPending(b), false);
    // run 3: nothing is pending any more
    assert.deepEqual(run({ maxSeconds: 60 }).computed, []);
  } finally { fx.cleanup(); }
});

test('git older than 2.31 is named once in the landings instead of leaving every session silently unattributed', () => {
  const fx = makeFixture();
  try {
    const dir = join(fx.dir, 'work');
    mkdirSync(dir, { recursive: true });
    const old = (d, args) => (args[0] === '--version' ? 'git version 2.30.2\n' : null); // rev-parse --path-format=absolute is refused
    const rows = [row('2026-11-18T12:00:00.000Z', 's', { main: { [SONNET]: 3 }, cwd: dir })];
    const l = landingsOf({ rows, used: USED, fromMs: FROM, toMs: TO, git: old });
    assert.deepEqual(l.repos, []);
    assert.match(l.gitNote, /git 2\.30 is older than 2\.31/);
    assert.match(efficiencyLines({ landings: l }).join('\n'), /git 2\.30 is older than 2\.31/);
    const fresh = landingsOf({ rows, used: USED, fromMs: FROM, toMs: TO, git: (d, args) => (args[0] === '--version' ? 'git version 2.43.0\n' : null) });
    assert.equal(fresh.gitNote, undefined, 'a current git that merely found no repository says nothing about its version');
    assert.equal(landingsOf({ rows, used: USED, fromMs: FROM, toMs: TO, git: () => null }).gitNote, undefined);
  } finally { fx.cleanup(); }
});

test('rowUnits prices main and subagent tokens with the day file\'s weights', () => {
  const r = row('2026-11-18T10:00:00.000Z', 's', { main: { [SONNET]: 4 }, sub: { [SONNET]: 6 } });
  assert.equal(rowUnits(r, USED), 10);
  assert.equal(rowUnits(r, USED, 'm'), 4);
  assert.equal(rowUnits(r, USED, 's'), 6);
  assert.equal(rowUnits(r, {}), 0);
});

test('handoff counts: notices, repeats, denies, send-backs, continuations, and distinct subagents over the limit, only the day\'s rows', () => {
  const at = (h) => `2026-11-18T${h}:00:00.000Z`;
  const rows = [
    { at: at('09'), agent_id: 'a1', action: 'notice', limit: 'soft', limit_tokens: 100000, tokens: 101000 },
    { at: at('10'), agent_id: 'a1', action: 'repeat', limit: 'soft', limit_tokens: 100000, tokens: 131000 },
    { at: at('11'), agent_id: 'a1', action: 'deny', limit: 'hard', limit_tokens: 150000, tokens: 151000 },
    { at: at('12'), agent_id: 'a1', action: 'deny', limit: 'hard', limit_tokens: 150000, tokens: 160000 },
    { at: at('13'), agent_id: 'a2', action: 'end-block', limit: 'soft', limit_tokens: 100000, tokens: 120000 },
    { at: at('14'), agent_id: 'a2', action: 'return', limit: 'soft', limit_tokens: 100000, tokens: 120000 },
    { at: at('15'), agent_id: 'a3', action: 'notice', limit: 'soft', limit_tokens: 100000, tokens: 102000 },
    { at: '2026-11-17T09:00:00.000Z', agent_id: 'a4', action: 'deny', limit: 'hard', limit_tokens: 150000, tokens: 190000 }, // another day
  ];
  const h = handoffOf({ rows, fromMs: FROM, toMs: TO });
  assert.deepEqual([h.softNotices, h.repeats, h.hardDenies, h.endBlocks, h.continuations, h.overLimit, h.rows], [2, 1, 2, 1, 1, 1, 7]);
  assert.ok(handoffOf({ rows: null, fromMs: FROM, toMs: TO }).gap);
  const eff = computeEfficiency({ f: { weightsUsed: USED, rows: [], spawns: [] }, fromMs: FROM, toMs: TO, seams: { transcriptsRoot: null, handoffRows: rows } });
  assert.equal(eff.handoff.continuations, 1);
  const text = efficiencyLines(eff).join('\n');
  assert.match(text, /2 soft notices \(1 repeats\), 2 hard denies, 1 end-of-run send-backs, 1 continuations the lead was told to spawn; 1 subagents went over the hard limit anyway/);
  assert.match(efficiencyLines({ ...eff, handoff: undefined }).join('\n'), /computed before handoff counts existed/);
  assert.match(efficiencyLines({ ...eff, handoff: { gap: 'no handoff-limit.jsonl' } }).join('\n'), /Not measured: no handoff-limit\.jsonl/);
});
