// Accounts (0.31.59): hooks/lib/account.mjs (current account, account history), the account tag on plan-meter samples and the readers
// that use only the current account's samples (hooks/lib/plan-meter.mjs), the units-per-percent rate per account or plan
// (hooks/lib/plan-allowance.mjs), the session budget that uses it, and the per-account calibration (scripts/calibrate-weights.mjs).
// Account ids below are invented.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { stateDir } from '../hooks/lib/context.mjs';
import { currentAccount, accountHistory, accountAt, noteAccount, uncertainSpans } from '../hooks/lib/account.mjs';
import { sampleLine, readSampleLines, samplesOf, latestSample } from '../hooks/lib/plan-meter.mjs';
import {
  _resetPlanWeightsForTests, unitsPerPercent, unitsPerPercentFor, currentRate, rateLabel, weeklyLimitUnits, allowanceNoteText,
} from '../hooks/lib/plan-allowance.mjs';
import { weeklyPlanUnits, budgetNoticeText } from '../hooks/lib/session-budget.mjs';
import { fitRate, fitAccounts, applyAccountPlan, writeUserFile, dedupeReadings, readSamples } from '../scripts/calibrate-weights.mjs';

// UUID-shaped (the app record is matched as one) and built from one letter each, so no hex run sits in the source
const uuidOf = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const A = uuidOf('a');
const B = uuidOf('b');
const C = uuidOf('c');
const TOOL = 'mcp__ccd_session_mgmt__get_usage';

const write = (file, data) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };
const syncDir = (fx) => join(fx.dir, '.claude', 'session-sync', 'accounts');
const appConfig = (fx) => join(fx.dir, 'desktop', 'config.json'); // AGENT_COMPANION_DESKTOP_DIR is <dir>/desktop in the fixture
const samplesFile = () => join(stateDir(), 'plan-meter-samples.jsonl');
const userWeights = (fx, obj) => { write(join(fx.stateDir, 'config', 'plan-weights.json'), obj); _resetPlanWeightsForTests(); };
const line = (ts, weekly, extra = {}) => JSON.stringify({ ts, source: 'get_usage', weekly_pct: weekly, ...extra });
const usageResult = (pct = 40, plan = 'Max') => JSON.stringify({
  plan: { status: 'ok', plan, windows: [{ label: 'Weekly · all models', percentUsed: pct, resetsAt: '2026-11-27T16:00:00.000Z', resetsIn: '1d' }] },
  context: { session: 'self', status: 'ok' },
});

// --- 1. The helper: current account and history ----------------------------------------------------------------------------------

test('currentAccount: null with no source, from the app record, else from session-sync; bad files are ignored', () => {
  const fx = makeFixture();
  try {
    assert.equal(currentAccount(), null, 'no source at all');
    assert.deepEqual(accountHistory({ samples: [] }), []);
    write(join(syncDir(fx), 'state.json'), '{ not json');
    write(join(syncDir(fx), 'switch-history.json'), '"a string"');
    assert.equal(currentAccount(), null, 'malformed JSON and another shape');
    write(join(syncDir(fx), 'state.json'), { signed: { acct: 12 } });
    assert.equal(currentAccount(), null, 'acct of the wrong type');
    write(join(syncDir(fx), 'state.json'), { signed: { acct: B, at: '2026-11-10T00:00:00Z' } });
    assert.equal(currentAccount(), B, 'session-sync state.json signed.acct');
    write(appConfig(fx), JSON.stringify({ other: 1, lastKnownAccountUuid: A, more: { nested: true } }));
    assert.equal(currentAccount(), A, 'the desktop app record wins over session-sync');
    write(appConfig(fx), '{"lastKnownAccountUuid":"not-a-uuid"}');
    assert.equal(currentAccount(), B, 'an app record that is not an id is ignored; falls back');
  } finally { fx.cleanup(); }
});

test('accountHistory: session-sync switches, its signed entry and the transitions in tagged samples, sorted, same-account runs collapsed', () => {
  const fx = makeFixture();
  try {
    write(join(syncDir(fx), 'switch-history.json'), [
      { at: '2026-11-05T10:00:00.000Z', acct: B },
      { at: '2026-11-01T10:00:00.000Z', acct: A },
      { at: 'garbage', acct: A },
      { at: '2026-11-03T10:00:00.000Z' },
      'x',
      { at: '2026-11-02T10:00:00.000Z', acct: A }, // same account again: collapsed
    ]);
    write(join(syncDir(fx), 'state.json'), { signed: { acct: A, at: '2026-11-08T10:00:00.000Z' } });
    const samples = [
      { ts: '2026-11-06T00:00:00.000Z', acct: B }, { ts: '2026-11-06T01:00:00.000Z', acct: B }, // same run: no new entry
      { ts: '2026-11-07T00:00:00.000Z', acct: null }, // untagged: not a transition
      { ts: '2026-11-09T00:00:00.000Z', acct: A },
    ];
    const h = accountHistory({ samples });
    assert.deepEqual(h, [
      { at: '2026-11-01T10:00:00.000Z', acct: A },
      { at: '2026-11-05T10:00:00.000Z', acct: B },
      { at: '2026-11-08T10:00:00.000Z', acct: A },
    ]);
    assert.equal(accountAt(h, '2026-10-30T00:00:00Z'), null, 'before the first entry');
    assert.equal(accountAt(h, Date.parse('2026-11-04T00:00:00Z')), A);
    assert.equal(accountAt(h, '2026-11-05T10:00:00.000Z'), B, 'at the entry itself');
    assert.equal(accountAt(h, '2026-12-01T00:00:00Z'), A);
    assert.equal(accountAt(h, 'nonsense'), null);
  } finally { fx.cleanup(); }
});

test('accountHistory from tagged samples alone (no session-sync), read from the samples file by default', () => {
  const fx = makeFixture();
  try {
    write(samplesFile(), [
      line('2026-11-01T00:00:00.000Z', 10, { acct: A }),
      line('2026-11-02T00:00:00.000Z', 12, { acct: A }),
      line('2026-11-03T00:00:00.000Z', 5, { acct: B }),
      line('2026-11-04T00:00:00.000Z', 14, { acct: A }),
    ].join('\n') + '\n');
    assert.deepEqual(accountHistory().map((e) => e.acct), [A, B, A]);
  } finally { fx.cleanup(); }
});

test('accountHistory: a switch seen only by samples or the plugin record is an UNCERTAIN interval, never a guessed time; session-sync dates are exact', () => {
  const fx = makeFixture();
  try {
    // no session-sync: A seen on Nov 1 and Nov 2, B first seen on Nov 5. The switch is somewhere in (Nov 2 12:00, Nov 5).
    const samples = [
      { ts: '2026-11-01T00:00:00.000Z', acct: A }, { ts: '2026-11-02T12:00:00.000Z', acct: A }, { ts: '2026-11-05T00:00:00.000Z', acct: B },
    ];
    const h = accountHistory({ samples });
    assert.deepEqual(h, [
      { at: '2026-11-01T00:00:00.000Z', acct: A },
      { at: '2026-11-05T00:00:00.000Z', acct: B, after: '2026-11-02T12:00:00.000Z' },
    ]);
    assert.equal(accountAt(h, '2026-11-02T12:00:00.000Z'), A, 'A was seen then');
    assert.equal(accountAt(h, '2026-11-03T00:00:00.000Z'), null, 'inside the uncertain interval: not A, not B');
    assert.equal(accountAt(h, '2026-11-04T23:59:00.000Z'), null);
    assert.equal(accountAt(h, '2026-11-05T00:00:00.000Z'), B);
    assert.deepEqual(uncertainSpans(h), [{ from: Date.parse('2026-11-02T12:00:00.000Z'), to: Date.parse('2026-11-05T00:00:00.000Z'), acct: A }]);

    // the same samples with session-sync's DATED switch to B on Nov 3: exact, nothing uncertain
    write(join(syncDir(fx), 'switch-history.json'), [{ at: '2026-11-03T08:00:00.000Z', acct: B }]);
    const exact = accountHistory({ samples });
    assert.deepEqual(exact, [{ at: '2026-11-01T00:00:00.000Z', acct: A }, { at: '2026-11-03T08:00:00.000Z', acct: B }]);
    assert.equal(accountAt(exact, '2026-11-04T00:00:00.000Z'), B);
    assert.deepEqual(uncertainSpans(exact), []);
    assert.deepEqual(uncertainSpans(null), []);
  } finally { fx.cleanup(); }
});

test('noteAccount: appends { at, acct } only when the account differs from the last entry; nothing when unchanged; fail-soft', () => {
  const fx = makeFixture();
  try {
    const file = join(fx.stateDir, 'state', 'account-history.jsonl');
    const rows = () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    assert.equal(noteAccount({ now: new Date('2026-11-01T00:00:00Z') }), false, 'no account source: nothing written');
    assert.equal(existsSync(file), false);
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: A }));
    assert.equal(noteAccount({ now: new Date('2026-11-01T00:00:00Z') }), true);
    assert.equal(noteAccount({ now: new Date('2026-11-02T00:00:00Z') }), false, 'unchanged: no write');
    assert.deepEqual(rows(), [{ at: '2026-11-01T00:00:00.000Z', acct: A }]);
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: B }));
    assert.equal(noteAccount({ now: new Date('2026-11-04T00:00:00Z') }), true);
    assert.equal(noteAccount({ account: B, now: new Date('2026-11-05T00:00:00Z') }), false);
    assert.deepEqual(rows().map((r) => r.acct), [A, B]);
    // merged into the history: the switch is somewhere between the last sign of A and the first sign of B
    const h = accountHistory({ samples: [{ ts: '2026-11-02T06:00:00.000Z', acct: A }] });
    assert.deepEqual(h, [{ at: '2026-11-01T00:00:00.000Z', acct: A }, { at: '2026-11-04T00:00:00.000Z', acct: B, after: '2026-11-02T06:00:00.000Z' }]);
    // a torn line and a bad record are skipped; an unwritable file is fail-soft
    writeFileSync(file, `${readFileSync(file, 'utf8')}{torn\n{"at":"x","acct":"y z"}\n`);
    assert.equal(accountHistory({ samples: [] }).length, 2);
    rmSync(file);
    mkdirSync(file); // a directory where the file should be: the append throws
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: C }));
    assert.equal(noteAccount(), false);
  } finally { fx.cleanup(); }
});

test('the SessionStart hook records the account once, and not again while it is unchanged', () => {
  const fx = makeFixture();
  try {
    const file = join(fx.stateDir, 'state', 'account-history.jsonl');
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: A }));
    const payload = { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: fx.dir };
    assert.equal(runHook('hooks/settings-journal.mjs', payload).status, 0);
    assert.equal(runHook('hooks/settings-journal.mjs', { ...payload, session_id: 's2' }).status, 0);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, 'one entry for two sessions');
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: B }));
    assert.equal(runHook('hooks/settings-journal.mjs', { ...payload, session_id: 's3' }).status, 0);
    assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).acct), [A, B]);
    // no account source: the hook writes nothing and exits 0
    rmSync(file); rmSync(appConfig(fx));
    assert.equal(runHook('hooks/settings-journal.mjs', payload).status, 0);
    assert.equal(existsSync(file), false);
  } finally { fx.cleanup(); }
});

test('the app record is looked for in the per-platform folder (win32, darwin, linux) when no seam is set', () => {
  const fx = makeFixture();
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const seam = process.env.AGENT_COMPANION_DESKTOP_DIR;
  try {
    delete process.env.AGENT_COMPANION_DESKTOP_DIR;
    const places = {
      win32: ['AppData', 'Roaming', 'Claude'],
      darwin: ['Library', 'Application Support', 'Claude'],
      linux: ['.config', 'Claude'],
    };
    for (const [platform, parts] of Object.entries(places)) {
      Object.defineProperty(process, 'platform', { value: platform });
      assert.equal(currentAccount(), null, `${platform}: no record yet`);
      write(join(fx.dir, ...parts, 'config.json'), JSON.stringify({ lastKnownAccountUuid: A }));
      assert.equal(currentAccount(), A, `${platform}: ${parts.join('/')}`);
      for (const other of Object.keys(places)) {
        if (other === platform) continue;
        Object.defineProperty(process, 'platform', { value: other });
        assert.equal(currentAccount(), null, `${other} does not look in the ${platform} folder`);
      }
      rmSync(join(fx.dir, ...parts, 'config.json'));
    }
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    if (seam === undefined) delete process.env.AGENT_COMPANION_DESKTOP_DIR; else process.env.AGENT_COMPANION_DESKTOP_DIR = seam;
    fx.cleanup();
  }
});

// --- 2. Samples are tagged; readers use the current account's -----------------------------------------------------------------------

test('sampleLine: the account is written as acct when known and left out when not', () => {
  const r = { weekly: 40, fable: null, fiveHour: null, plan: 'Max', weeklyResetsAt: null, fiveHourResetsAt: null };
  assert.equal(sampleLine(r, { ts: 't', account: A }).acct, A);
  assert.equal('acct' in sampleLine(r, { ts: 't', account: null }), false);
  assert.equal('acct' in sampleLine(r, { ts: 't' }), false);
});

test('the sampler tags the line with the signed-in account (app record), and writes no acct when none is known', () => {
  const fx = makeFixture();
  try {
    const payload = { tool_name: TOOL, session_id: 's1', tool_response: usageResult(40) };
    assert.equal(runHook('hooks/plan-meter-sample.mjs', payload).status, 0);
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: A }));
    assert.equal(runHook('hooks/plan-meter-sample.mjs', payload).status, 0);
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: B }));
    assert.equal(runHook('hooks/plan-meter-sample.mjs', payload).status, 0);
    const rows = readFileSync(samplesFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 3);
    assert.equal('acct' in rows[0], false, 'no account source: the line is what it always was');
    assert.equal(rows[1].acct, A);
    assert.equal(rows[2].acct, B);
    assert.equal(rows[1].plan, 'Max');
  } finally { fx.cleanup(); }
});

test('readers: only the current account\'s samples; untagged ones count only while nothing is tagged; never another account\'s reading', () => {
  const fx = makeFixture();
  try {
    write(samplesFile(), [
      line('2026-11-01T00:00:00.000Z', 20, { plan: 'Max' }), // old, untagged
      line('2026-11-02T00:00:00.000Z', 30, { plan: 'Max' }),
    ].join('\n') + '\n');
    let all = readSampleLines();
    assert.equal(all.length, 2);
    assert.equal(samplesOf(all, A).length, 2, 'nothing tagged: every sample counts as the current account\'s');
    assert.equal(latestSample(A, all).weekly, 30);
    assert.equal(samplesOf(all, null).length, 2);

    writeFileSync(samplesFile(), `${line('2026-11-01T00:00:00.000Z', 20)}\n${line('2026-11-03T00:00:00.000Z', 55, { acct: A, plan: 'Ultra', weekly_resets_at: '2026-11-06T16:00:00.000Z' })}\n${line('2026-11-04T00:00:00.000Z', 88, { acct: B, plan: 'Max' })}\n${line('2026-11-05T00:00:00.000Z', 61, { acct: A, plan: 'Ultra', weekly_resets_at: '2026-11-06T16:00:00.000Z' })}\n{torn`);
    all = readSampleLines();
    assert.equal(all.length, 4, 'a torn line is skipped');
    assert.deepEqual(samplesOf(all, A).map((s) => s.weekly), [55, 61]);
    assert.deepEqual(samplesOf(all, B).map((s) => s.weekly), [88]);
    assert.deepEqual(samplesOf(all, null).map((s) => s.weekly), [20], 'an unknown account matches only untagged samples');
    const a = latestSample(A, all);
    assert.equal(a.weekly, 61);
    assert.equal(a.plan, 'Ultra');
    assert.equal(a.weeklyResetsAt, '2026-11-06T16:00:00.000Z', 'the account\'s own reset time');
    assert.equal(latestSample(C, all), null, 'an account with no sample yet: the no-reading case');
  } finally { fx.cleanup(); }
});

// --- 3. The rate ------------------------------------------------------------------------------------------------------------------

test('rate: account entry, else plan entry, else the shipped default with its provenance', () => {
  const fx = makeFixture();
  try {
    const d = unitsPerPercentFor({ account: A, plan: 'Max' });
    assert.equal(d.basis, 'default');
    assert.equal(d.value, unitsPerPercent());
    assert.equal(d.value, 28.6);
    assert.match(rateLabel(d), /^28\.6 units = 1% \(shipped default, measured 2026-11-03\)$/);

    userWeights(fx, {
      unitsPerPercentByAccount: { [B]: { value: 14.3, status: 'measured', date: '2026-11-20' }, [A]: 40 },
      unitsPerPercentByPlan: { Max: { value: 20 }, pro: 5 },
    });
    assert.deepEqual([unitsPerPercentFor({ account: B, plan: 'Max' }).basis, unitsPerPercentFor({ account: B }).value], ['account', 14.3]);
    assert.equal(unitsPerPercentFor({ account: A }).value, 40, 'a bare number is a rate');
    assert.deepEqual([unitsPerPercentFor({ plan: 'max' }).basis, unitsPerPercentFor({ plan: 'max' }).value], ['plan', 20], 'plan names match without case');
    assert.equal(unitsPerPercentFor({ account: C, plan: 'Ultra' }).basis, 'default', 'no entry for it: the default, not another account\'s');
    assert.match(rateLabel(unitsPerPercentFor({ account: B })), /^14\.3 units = 1% \(account bbbbbbbb, measured 2026-11-20\)$/);
    userWeights(fx, { unitsPerPercentByAccount: { [A]: { value: -3 }, [B]: 'x' } });
    assert.equal(unitsPerPercentFor({ account: A }).basis, 'default', 'a non-positive or non-numeric rate is ignored');
    assert.equal(unitsPerPercentFor({ account: B }).basis, 'default');
  } finally { fx.cleanup(); _resetPlanWeightsForTests(); }
});

test('currentRate follows the account in use: switch accounts and the rate changes, an unknown account gets the default', () => {
  const fx = makeFixture();
  try {
    userWeights(fx, { unitsPerPercentByAccount: { [B]: { value: 14.3, status: 'measured', date: '2026-11-20' } }, unitsPerPercentByPlan: { Max: 20 } });
    assert.equal(currentRate().basis, 'default', 'no account source');
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: A }));
    assert.equal(currentRate().basis, 'default', 'account A has no entry (and no sample to name its plan)');
    write(samplesFile(), `${line('2026-11-04T00:00:00.000Z', 30, { acct: A, plan: 'Max' })}\n${line('2026-11-04T00:00:00.000Z', 30, { acct: B, plan: 'Ultra' })}\n`);
    assert.deepEqual([currentRate().basis, currentRate().value], ['plan', 20], 'A is on the Max plan by its own newest sample');
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: B }));
    assert.deepEqual([currentRate().basis, currentRate().value], ['account', 14.3]);
  } finally { fx.cleanup(); _resetPlanWeightsForTests(); }
});

test('the session budget and the allowance note use the current account\'s rate and say so; the default text is unchanged', () => {
  const fx = makeFixture();
  try {
    assert.equal(weeklyPlanUnits(), 2860);
    assert.match(budgetNoticeText(700), /has used about 700 plan units \(~24% of a ~2,860-unit week\)\. /);
    const plain = allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'high', root: '/p', agentId: 'ag' });
    assert.match(plain, /Allowance: 3% of the weekly limit \(85\.8 units\), /);

    userWeights(fx, { unitsPerPercentByAccount: { [B]: { value: 14.3, status: 'measured', date: '2026-11-20' } } });
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: B }));
    assert.equal(weeklyPlanUnits(), 1430);
    assert.equal(weeklyLimitUnits(14.3), 1430);
    assert.match(budgetNoticeText(143), /\(~10% of a ~1,430-unit week, at 14\.3 units = 1% \(account bbbbbbbb, measured 2026-11-20\)\)\./);
    assert.match(allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'high', root: '/p', agentId: 'ag' }), /Allowance: 3% of the weekly limit \(42\.9 units at 14\.3 per 1%, account rate\), /);
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: A }));
    assert.equal(weeklyPlanUnits(), 2860, 'the other account: the default week, never B\'s');
    assert.doesNotMatch(budgetNoticeText(700), /units = 1%/);
  } finally { fx.cleanup(); _resetPlanWeightsForTests(); }
});

// --- Single account: nothing changes ---------------------------------------------------------------------------------------------------

test('single-account regression: with no account source behaviour is what it was (rate, week, notice, sample line, readers)', () => {
  const fx = makeFixture();
  try {
    assert.equal(currentAccount(), null);
    assert.deepEqual(accountHistory(), []);
    const r = currentRate();
    assert.deepEqual([r.basis, r.value, r.key], ['default', 28.6, null]);
    assert.equal(weeklyPlanUnits(), 2860);
    assert.equal(weeklyLimitUnits(), 2860);
    assert.match(budgetNoticeText(700), /has used about 700 plan units \(~24% of a ~2,860-unit week\)\. A hand-off/);
    assert.match(allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'high', root: '/p', agentId: 'ag' }), /\(85\.8 units\), about /);
    // the sampler writes the same line it always did, and every reader sees every sample
    assert.equal(runHook('hooks/plan-meter-sample.mjs', { tool_name: TOOL, session_id: 's', tool_response: usageResult(40) }).status, 0);
    const row = JSON.parse(readFileSync(samplesFile(), 'utf8').trim());
    assert.deepEqual(Object.keys(row), ['ts', 'source', 'weekly_pct', 'plan', 'session_id', 'weekly_resets_at']);
    write(samplesFile(), `${line('2026-11-01T00:00:00.000Z', 10)}\n${line('2026-11-02T00:00:00.000Z', 20)}\n`);
    const s = readSampleLines();
    assert.equal(samplesOf(s, null).length, 2);
    assert.equal(latestSample(null, s).weekly, 20);
    assert.equal(readSamples(samplesFile()).length, 2);
    assert.equal(readSamples(samplesFile())[0].acct, null);
  } finally { fx.cleanup(); }
});

test('single account WITH tags and no rate configured: the rate is still the default and every sample is that account\'s', () => {
  const fx = makeFixture();
  try {
    write(appConfig(fx), JSON.stringify({ lastKnownAccountUuid: A }));
    write(samplesFile(), `${line('2026-11-01T00:00:00.000Z', 10)}\n${line('2026-11-02T00:00:00.000Z', 20, { acct: A })}\n`);
    assert.equal(currentRate().basis, 'default');
    assert.equal(weeklyPlanUnits(), 2860);
    assert.equal(latestSample(A).weekly, 20);
  } finally { fx.cleanup(); }
});

// --- 4. Calibration per account ------------------------------------------------------------------------------------------------------

const DAY = 24 * 3600e3;
const T0 = Date.parse('2026-09-04T16:00:00.000Z');
// Two accounts that alternate by day; sonnet only, 6 requests a day of ~30 plan units (output tokens x 5 x $2/MTok = out x 1e-5 units).
// Each account's meter is units since its window opened / its own rate (A 10 units per 1%, B 20), its windows reset 2 days apart.
function twoAccounts() {
  const rate = { [A]: 10, [B]: 20 };
  const reset0 = { [A]: T0 + 7 * DAY, [B]: T0 + 9 * DAY };
  const acctOfDay = (d) => (d % 2 === 0 ? A : B);
  const reqs = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let d = 0; d < 23; d++) for (let k = 0; k < 6; k++) reqs.push({ t: T0 + d * DAY + (k + 1) * 3 * 3600e3, fam: 'sonnet', in: 0, out: Math.round((20 + 20 * rnd()) * 1e5), cw5: 0, cw1: 0, cr: 0, acct: acctOfDay(d) });
  const units = (q) => q.out * 1e-5;
  const readings = [];
  for (let d = 0; d < 23; d++) {
    const acct = acctOfDay(d);
    const t = T0 + d * DAY + 20 * 3600e3;
    const win = reset0[acct] + (t >= reset0[acct] ? Math.floor((t - reset0[acct]) / (7 * DAY)) + 1 : 0) * 7 * DAY; // the reset that ends this account's window
    const used = reqs.filter((q) => q.acct === acct && q.t >= win - 7 * DAY && q.t <= t).reduce((s, q) => s + units(q), 0);
    readings.push({ t, weekly: Math.round(used / rate[acct]), fable: null, fiveHour: null, resetMs: win, source: 'samples', acct });
  }
  const history = Array.from({ length: 23 }, (_, d) => ({ at: new Date(T0 + d * DAY - (d === 0 ? 3600e3 : 0)).toISOString(), acct: acctOfDay(d) }));
  return { reqs, readings, history };
}

test('calibration: a rate per account from tagged readings and the requests made while that account was signed in', () => {
  const { reqs, readings, history } = twoAccounts();
  const r = fitAccounts(readings, reqs, history, { boot: 200 });
  assert.deepEqual(Object.keys(r).sort(), [A, B].sort());
  assert.ok(r[A].enough && r[B].enough, JSON.stringify(r));
  assert.ok(Math.abs(r[A].upp.value - 10) < 1.5, `A ${r[A].upp.value}`);
  assert.ok(Math.abs(r[B].upp.value - 20) < 3, `B ${r[B].upp.value}`);
  assert.ok(r[A].windows >= 3 && r[B].windows >= 3, `${r[A].windows} ${r[B].windows}`);
  assert.ok(r[A].upp.interval[0] <= r[A].upp.value && r[A].upp.value <= r[A].upp.interval[1]);
  // an untagged reading is given to the account the history says was signed in
  const untagged = readings.map((x) => ({ ...x, acct: null, source: 'transcript' }));
  assert.deepEqual(fitAccounts(untagged, reqs, history, { boot: 50 }), {}, 'no tagged reading: no per-account fit at all');
  // readings tagged for A only: B's untagged readings are given to B by the history, but B is not fitted (no tagged reading of its own)
  const onlyA = readings.map((x) => (x.acct === A ? x : { ...x, acct: null }));
  assert.deepEqual(Object.keys(fitAccounts(onlyA, reqs, history, { boot: 50 })), [A]);
});

test('calibration: a window holding a span of unknown switch time is left out and counted as unattributed, never guessed', () => {
  const { reqs, readings, history } = twoAccounts();
  const exact = fitAccounts(readings, reqs, history, { boot: 100 });
  // the same switches, but each only SEEN half a day after the previous account's last sign: the interval between is unknown
  const guessed = history.map((e, i) => (i === 0 ? e : { ...e, after: new Date(Date.parse(e.at) - 12 * 3600e3).toISOString() }));
  const r = fitAccounts(readings, reqs, guessed, { boot: 100 });
  for (const a of [A, B]) {
    assert.ok(exact[a].windows >= 3 && exact[a].unattributedWindows === 0, `${a} exact ${JSON.stringify(exact[a])}`);
    assert.ok(r[a].unattributedWindows > 0, `${a} ${JSON.stringify(r[a])}`);
    assert.ok(r[a].windows < exact[a].windows, `${a}: ${r[a].windows} windows against ${exact[a].windows}`);
  }
  assert.ok(applyAccountPlan(r).patch.unitsPerPercentByAccount === undefined, 'nothing written from windows that are all unattributed');
});

test('calibration: a window that opened before the history began is not used; too few rows is no fit', () => {
  const { reqs, readings, history } = twoAccounts();
  const late = history.slice(10); // history known only from day 10: no window of either account opened after it with >= 3 windows
  const r = fitAccounts(readings, reqs, late, { boot: 50 });
  for (const a of Object.values(r)) assert.ok(!a.enough || a.windows < 3);
  assert.equal(fitRate([{ y: 5, U: { sonnet: 10, opus: 0, haiku: 0, fable: 0 } }]), null);
});

test('calibration --apply: writes each account\'s rate (with provenance) to the user file only with 3+ windows; a tighter interval replaces one', () => {
  const fx = makeFixture();
  try {
    const { reqs, readings, history } = twoAccounts();
    const accounts = fitAccounts(readings, reqs, history, { boot: 200 });
    const plan = applyAccountPlan(accounts, undefined, '2026-11-20');
    assert.ok(plan.patch.unitsPerPercentByAccount[A] && plan.patch.unitsPerPercentByAccount[B], JSON.stringify(plan.decisions));
    const e = plan.patch.unitsPerPercentByAccount[A];
    assert.equal(e.status, 'measured');
    assert.equal(e.date, '2026-11-20');
    assert.match(e.source, /calibrate-weights\.mjs 2026-11-20: \d+ official weekly readings in \d+ windows of this account/);
    const thin = applyAccountPlan({ [A]: { enough: true, n: 20, windows: 2, upp: { value: 10, interval: [9, 11] } } });
    assert.match(thin.decisions[0].reason, /only 2 window/);
    assert.equal(thin.patch.unitsPerPercentByAccount, undefined);
    const none = applyAccountPlan({ [A]: { enough: false, n: 3, windows: 1 } });
    assert.equal(none.decisions[0].apply, false);
    // the same bar as the global fit: 3+ windows is not enough when the interval is wide or missing (a thin fit is shown, not written)
    const wideNew = applyAccountPlan({ [A]: { enough: true, n: 40, windows: 5, upp: { value: 10, interval: [4, 30] } } });
    assert.equal(wideNew.patch.unitsPerPercentByAccount, undefined);
    assert.match(wideNew.decisions[0].reason, /not tighter than the default/);
    const noInterval = applyAccountPlan({ [A]: { enough: true, n: 40, windows: 5, upp: { value: 10, interval: null } } });
    assert.equal(noInterval.patch.unitsPerPercentByAccount, undefined);
    const sharp = applyAccountPlan({ [A]: { enough: true, n: 40, windows: 5, upp: { value: 10, interval: [9.95, 10.05] } } });
    assert.ok(sharp.patch.unitsPerPercentByAccount[A], 'relative width 1% against the default 1.4%: tighter, written');

    const file = join(fx.stateDir, 'config', 'plan-weights.json');
    writeUserFile(plan.patch, file);
    _resetPlanWeightsForTests();
    const j = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(j.unitsPerPercentByAccount).sort(), [A, B].sort());
    assert.equal(unitsPerPercentFor({ account: B }).basis, 'account');
    assert.ok(Math.abs(unitsPerPercentFor({ account: B }).value - 20) < 3);
    assert.equal(unitsPerPercentFor({ account: A }).status, 'measured');
    assert.equal(unitsPerPercent(), 28.6, 'the default is untouched');
    // an account that already has an entry is replaced only by a tighter interval
    writeUserFile({ unitsPerPercentByAccount: { [A]: { value: 10, interval: [8, 12] } } }, file);
    _resetPlanWeightsForTests();
    const wide = applyAccountPlan({ [A]: { enough: true, n: 20, windows: 4, upp: { value: 10, interval: [1, 50] } } });
    assert.equal(wide.decisions[0].apply, false);
    const tight = applyAccountPlan({ [A]: { enough: true, n: 20, windows: 4, upp: { value: 10, interval: [9.99, 10.01] } } });
    assert.equal(tight.decisions[0].apply, true);
  } finally { fx.cleanup(); _resetPlanWeightsForTests(); }
});

test('calibration: a reading seen in the samples (tagged) and in a transcript (untagged) counts once and keeps the tag', () => {
  const t = Date.parse('2026-11-03T12:00:00Z');
  const base = { weekly: 40, fable: null, fiveHour: null, resetMs: Date.parse('2026-11-06T16:00:00Z') };
  const out = dedupeReadings([{ ...base, t: t - 20e3, source: 'transcript', acct: null }, { ...base, t, source: 'samples', acct: A }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].acct, A);
});

test('calibration CLI: no tagged sample means no account output at all', () => {
  const fx = makeFixture();
  try {
    write(join(fx.dir, 's.jsonl'), `${line('2026-11-01T00:00:00.000Z', 10)}\n`);
    const r = runHook('scripts/calibrate-weights.mjs', undefined, { args: ['--projects', join(fx.dir, 'none'), '--samples', join(fx.dir, 's.jsonl'), '--json'] });
    assert.equal(r.status, 1, 'not enough readings, as before');
    assert.equal(r.stdout.includes('accounts'), false);
    assert.equal(existsSync(join(fx.stateDir, 'config', 'plan-weights.json')), false);
  } finally { fx.cleanup(); }
});
