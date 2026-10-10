// The five lead-effort metrics of the decision register (leads-at-high): re-briefs, review FIX
// share, routing denials, under-provisioned share and main units per spawn. Each is tested
// normal, thin sample, gap day and with a frozen staged baseline. Fixtures are synthetic with
// fixed 2026 timestamps; nothing reads the operator's register, telemetry or network.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRegister, evaluateTriggers, evalMetric, emptyState, METRIC_CATALOG,
} from '../scripts/lib/decision-register.mjs';

const T = (s) => Date.parse(s);
const AF = T('2026-10-10T08:00:00Z'); // the switch instant; days 10-10 on are post
const NOW = T('2026-10-12T10:00:00Z'); // days through 10-11 are closed
const ROLLOUT = { 'leads-high': AF };
const clone = (x) => JSON.parse(JSON.stringify(x));

// A checkup day 'YYYY-MM-DD' runs 08:00Z to 07:59Z: row i of a day is at 09:00Z + i minutes.
const at = (day, i) => new Date(T(`${day}T09:00:00Z`) + i * 60000).toISOString();

// n distinct lead spawn rows of one session on `day` at effort `eff`, then `re` more rows that repeat
// the description hash of the first `re` rows (re-briefs): n + re rows, re of them re-briefs.
function leadDay(day, n, re, eff, o = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      at: at(day, i), session_id: `s-${day}-${eff}`, caller_is_subagent: false, caller_effort: eff,
      desc_sha: `h-${day}-${eff}-${i}`, name_effective: `task${day}${eff}n${i}`, tool_use_id: `tu-${day}-${eff}-${i}`,
      declared_type: 'bounded-feature', fit: 'fit', ...o,
    });
  }
  for (let i = 0; i < re; i++) rows.push({ ...rows[i], at: at(day, n + i), tool_use_id: `tu-${day}-${eff}-r${i}`, name_effective: `again${day}${eff}n${i}` });
  return rows;
}

function reg(trigger) {
  return {
    schema: 'agent-companion/decision-register', version: 1,
    decisions: [{
      id: 'leads-at-high', title: 'Leads at high', status: 'active', decided: '2026-10-10', decision: 'd', reverse: 'r',
      rolloutId: 'leads-high', premises: [{ id: 'p1', text: 'claim', label: 'E' }], triggers: [trigger],
    }],
  };
}
function trig(metric, over = {}) {
  const hist = metric === 'mainUnitsPerLeadSpawn';
  return {
    id: 'lm', premise: 'p1', kind: 'metric', source: hist ? 'history' : 'spawns', metric,
    params: hist ? {} : { levels: ['high'] }, op: '>', threshold: 1.5, minSample: 20, minDays: 2,
    baseline: { mode: 'pre-window', ratio: true, preDays: 5, minPerDay: 10, ...(hist ? {} : { levels: ['xhigh'] }) },
    post: { minDays: 2 }, ...over,
  };
}
function drive(trigger, { history = [], spawnRows = [], denialRows = [], state = emptyState(), nowT = NOW } = {}) {
  const evaluators = { changelog: () => null, metric: (c) => evalMetric({ ...c, activeFromMs: AF }), exercise: () => null };
  const out = evaluateTriggers({ register: reg(trigger), history, spawnRows, denialRows, nowT, state, evaluators });
  return { ...out, state, rec: state.triggers['leads-at-high/lm'], base: state.baselines['leads-at-high/lm'] };
}
const PRE_DAYS = ['2026-10-05', '2026-10-06', '2026-10-07'];
const POST_DAYS = ['2026-10-10', '2026-10-11'];

test('catalog and validation: the five metrics, levels required, baseline.levels checked', () => {
  for (const m of ['leadRebriefsPer100Spawns', 'reviewFixShareByLeadEffort', 'leadRoutingDeniesPer100Spawns', 'leadUnderProvisionedShare']) assert.equal(METRIC_CATALOG[m], 'spawns');
  assert.equal(METRIC_CATALOG.mainUnitsPerLeadSpawn, 'history');
  assert.deepEqual(validateRegister(reg(trig('leadRebriefsPer100Spawns')), { rollout: ROLLOUT }), { ok: true, errors: [] });
  assert.deepEqual(validateRegister(reg(trig('mainUnitsPerLeadSpawn')), { rollout: ROLLOUT }), { ok: true, errors: [] });
  const noLevels = trig('leadUnderProvisionedShare', { params: {} });
  assert.match(validateRegister(reg(noLevels), { rollout: ROLLOUT }).errors.join('|'), /needs params\.levels/);
  const wrongSource = trig('leadRebriefsPer100Spawns', { source: 'history' });
  assert.match(validateRegister(reg(wrongSource), { rollout: ROLLOUT }).errors.join('|'), /reads source "spawns"/);
  const histLevels = trig('mainUnitsPerLeadSpawn', { params: { levels: ['high'] } });
  assert.match(validateRegister(reg(histLevels), { rollout: ROLLOUT }).errors.join('|'), /cannot split by effort/);
  const badBase = trig('leadRebriefsPer100Spawns'); badBase.baseline.levels = 'xhigh';
  assert.match(validateRegister(reg(badBase), { rollout: ROLLOUT }).errors.join('|'), /baseline\.levels/);
  const histBase = trig('mainUnitsPerLeadSpawn'); histBase.baseline.levels = ['xhigh'];
  assert.match(validateRegister(reg(histBase), { rollout: ROLLOUT }).errors.join('|'), /baseline\.levels/);
});

// ----- leadRebriefsPer100Spawns ------------------------------------------------------------

test('rebriefs: normal. 5 per 100 at xhigh before, 20 per 100 at high after: ratio 4, flags after 2 days', () => {
  // 20 distinct rows + 1 repeat = 21 rows per pre day (1/21 re-briefs); post days 20 + 5 repeats = 25 rows (5/25)
  const rows = [...PRE_DAYS.flatMap((d) => leadDay(d, 20, 1, 'xhigh')), ...POST_DAYS.flatMap((d) => leadDay(d, 20, 5, 'high'))];
  const out = drive(trig('leadRebriefsPer100Spawns'), { spawnRows: rows });
  const pre = (1 / 21) * 100; const post = (5 / 25) * 100;
  assert.ok(Math.abs(out.base.pooled - pre) < 1e-9, `pre ${out.base.pooled}`);
  assert.ok(Math.abs(out.rec.value - post / pre) < 1e-9, `ratio ${out.rec.value}`);
  assert.deepEqual(out.newFlags, ['leads-at-high/lm@2026-10-10']);
});

test('rebriefs: same base name within 6 h counts, after 6 h or in another session it does not', () => {
  const lead = (i, o) => ({ at: new Date(T('2026-10-10T09:00:00Z') + i * 3600000).toISOString(), session_id: 's1', caller_is_subagent: false, caller_effort: 'high', desc_sha: `d${i}`, ...o });
  const rows = [
    lead(0, { name_effective: 'scout-copy-fix' }), lead(1, { name_effective: 'scout-copy-fix-2' }), // re-brief by base name (1 h)
    lead(9, { name_effective: 'scout-copy-fix-3' }), // 8 h after the previous one: not
    lead(10, { name_effective: 'other', session_id: 's2' }), lead(11, { name_effective: 'other-2', session_id: 's3' }), // other sessions: not
    lead(12, { name_effective: 'x', desc_sha: 'd10', session_id: 's2' }), // same hash as s2's row 10, 2 h: yes
  ];
  const t = trig('leadRebriefsPer100Spawns', { baseline: undefined, post: undefined, minSample: 1, minDays: 1, threshold: 0 });
  const v = evalMetric({ decision: {}, trigger: t, key: 'k', history: [], spawnRows: rows, nowT: NOW, state: emptyState(), activeFromMs: null });
  assert.equal(v.days.find((d) => d.qualifies).value, (2 / 6) * 100);
});

test('rebriefs: thin sample (fewer rows than minPerDay) keeps the baseline unusable and a thin post day silent', () => {
  const thinPre = [...PRE_DAYS.flatMap((d) => leadDay(d, 4, 1, 'xhigh')), ...POST_DAYS.flatMap((d) => leadDay(d, 20, 5, 'high'))];
  const a = drive(trig('leadRebriefsPer100Spawns'), { spawnRows: thinPre });
  assert.deepEqual(a.newFlags, []);
  assert.equal(a.rec.baselineStatus, 'insufficient');
  assert.equal(a.base, undefined);
  const thinPost = [...PRE_DAYS.flatMap((d) => leadDay(d, 20, 1, 'xhigh')), ...POST_DAYS.flatMap((d) => leadDay(d, 4, 4, 'high'))];
  const b = drive(trig('leadRebriefsPer100Spawns'), { spawnRows: thinPost });
  assert.deepEqual(b.newFlags, [], 'post days of 8 rows are below minPerDay 10');
  assert.equal(b.rec.streak, 0);
});

test('rebriefs: a gap day (no high lead rows) neither flags nor resets', () => {
  const pre = PRE_DAYS.flatMap((d) => leadDay(d, 20, 1, 'xhigh'));
  const rows = [...pre, ...leadDay('2026-10-10', 20, 5, 'high'), ...leadDay('2026-10-11', 20, 5, 'xhigh'), ...leadDay('2026-10-12', 20, 5, 'high')];
  const out = drive(trig('leadRebriefsPer100Spawns', { minDays: 2 }), { spawnRows: rows, nowT: T('2026-10-13T10:00:00Z') });
  // 10-10 hit, 10-11 has only xhigh rows (a gap for levels [high]), 10-12 hit: streak 2, so it flags
  assert.equal(out.rec.streak, 2);
  assert.deepEqual(out.newFlags, ['leads-at-high/lm@2026-10-10']);
});

test('rebriefs: the baseline is frozen; rows pruned later change nothing', () => {
  const state = emptyState();
  const rows = [...PRE_DAYS.flatMap((d) => leadDay(d, 20, 1, 'xhigh')), ...leadDay('2026-10-10', 20, 5, 'high')];
  drive(trig('leadRebriefsPer100Spawns'), { spawnRows: rows, state, nowT: T('2026-10-11T10:00:00Z') });
  const frozen = clone(state.baselines['leads-at-high/lm']);
  assert.ok(frozen.frozenAt);
  const later = [...leadDay('2026-10-10', 20, 5, 'high'), ...leadDay('2026-10-11', 20, 5, 'high')];
  const out = drive(trig('leadRebriefsPer100Spawns'), { spawnRows: later, state });
  assert.deepEqual(state.baselines['leads-at-high/lm'], frozen);
  assert.deepEqual(out.newFlags, ['leads-at-high/lm@2026-10-10']);
});

// ----- reviewFixShareByLeadEffort ----------------------------------------------------------

// A day of `w` writer rows spawned by a lead at `eff`, each with one reviewer row (declared
// code-review, spawned by that writer, caller_is_subagent true); the first `fix` reviews say FIX.
function reviewDay(day, w, fix, eff, verdictField = true) {
  const rows = [];
  for (let i = 0; i < w; i++) {
    const id = `wr-${day}-${eff}-${i}`;
    rows.push({ at: at(day, i), session_id: `s-${day}`, caller_is_subagent: false, caller_effort: eff, tool_use_id: id, declared_type: 'bounded-feature' });
    rows.push({
      at: at(day, i + 30), session_id: `s-${day}`, caller_is_subagent: true, caller_effort: 'high', declared_type: 'code-review', caller_tool_use_id: id,
      ...(verdictField ? { review_verdict: i < fix ? 'VERDICT: FIX' : 'VERDICT: PASS' } : {}),
    });
  }
  return rows;
}
const rtrig = (o = {}) => trig('reviewFixShareByLeadEffort', { minSample: 10, baseline: { mode: 'pre-window', ratio: true, preDays: 5, minPerDay: 5, levels: ['xhigh'] }, ...o });

test('review fix share: normal. joins a reviewer to the lead effort of its writer; 25% before, 60% after', () => {
  const rows = [...PRE_DAYS.flatMap((d) => reviewDay(d, 8, 2, 'xhigh')), ...POST_DAYS.flatMap((d) => reviewDay(d, 10, 6, 'high'))];
  const out = drive(rtrig(), { spawnRows: rows });
  assert.ok(Math.abs(out.base.pooled - 25) < 1e-9);
  assert.ok(Math.abs(out.rec.value - 60 / 25) < 1e-9);
  assert.deepEqual(out.newFlags, ['leads-at-high/lm@2026-10-10']);
});

test('review fix share: BLOCK counts as a fix, a reviewer of a subagent-spawned writer is skipped', () => {
  const t = rtrig({ baseline: undefined, post: undefined, minSample: 1, minDays: 1, threshold: 0 });
  const day = '2026-10-10';
  const rows = [
    { at: at(day, 0), caller_is_subagent: false, caller_effort: 'high', tool_use_id: 'w1' },
    { at: at(day, 1), caller_is_subagent: true, caller_effort: 'high', declared_type: 'code-review', caller_tool_use_id: 'w1', review_verdict: 'BLOCK' },
    { at: at(day, 2), caller_is_subagent: true, caller_effort: 'high', declared_type: 'code-review', caller_tool_use_id: 'w1', review_verdict: 'VERDICT: PASS' },
    { at: at(day, 3), caller_is_subagent: true, caller_effort: 'high', tool_use_id: 'w2' }, // writer spawned by a subagent
    { at: at(day, 4), caller_is_subagent: true, caller_effort: 'high', declared_type: 'code-review', caller_tool_use_id: 'w2', review_verdict: 'FIX' },
  ];
  const v = evalMetric({ decision: {}, trigger: t, key: 'k', history: [], spawnRows: rows, nowT: NOW, state: emptyState(), activeFromMs: null });
  assert.equal(v.days.find((d) => d.qualifies).value, 50);
});

test('review fix share: an aliased reviewer row (declared_type_resolved code-review) is a sample', () => {
  const t = rtrig({ baseline: undefined, post: undefined, minSample: 1, minDays: 1, threshold: 0 });
  const day = '2026-10-10';
  const rows = [
    { at: at(day, 0), caller_is_subagent: false, caller_effort: 'high', tool_use_id: 'w1' },
    { at: at(day, 1), caller_is_subagent: true, caller_effort: 'high', declared_type: 'review', declared_type_resolved: 'code-review', caller_tool_use_id: 'w1', review_verdict: 'FIX' },
    { at: at(day, 2), caller_is_subagent: true, caller_effort: 'high', declared_type: 'review', declared_type_resolved: 'code-review', caller_tool_use_id: 'w1', review_verdict: 'PASS' },
  ];
  const v = evalMetric({ decision: {}, trigger: t, key: 'k', history: [], spawnRows: rows, nowT: NOW, state: emptyState(), activeFromMs: null });
  assert.equal(v.days.find((d) => d.qualifies).value, 50);
});

test('review fix share: thin sample and a gap day (no verdict field in telemetry)', () => {
  const thin = [...PRE_DAYS.flatMap((d) => reviewDay(d, 8, 2, 'xhigh')), ...POST_DAYS.flatMap((d) => reviewDay(d, 3, 3, 'high'))];
  assert.deepEqual(drive(rtrig(), { spawnRows: thin }).newFlags, [], 'pooled post sample 6 is below minSample 10');
  // verdicts missing everywhere: every day is a gap, the baseline stays unusable, nothing flags
  const noVerdict = [...PRE_DAYS.flatMap((d) => reviewDay(d, 8, 2, 'xhigh', false)), ...POST_DAYS.flatMap((d) => reviewDay(d, 10, 6, 'high', false))];
  const out = drive(rtrig(), { spawnRows: noVerdict });
  assert.deepEqual(out.newFlags, []);
  assert.equal(out.rec.baselineStatus, 'insufficient');
});

test('review fix share: the baseline freezes', () => {
  const state = emptyState();
  drive(rtrig(), { spawnRows: [...PRE_DAYS.flatMap((d) => reviewDay(d, 8, 2, 'xhigh')), ...reviewDay('2026-10-10', 10, 6, 'high')], state, nowT: T('2026-10-11T10:00:00Z') });
  const frozen = clone(state.baselines['leads-at-high/lm']);
  const out = drive(rtrig(), { spawnRows: POST_DAYS.flatMap((d) => reviewDay(d, 10, 6, 'high')), state });
  assert.deepEqual(state.baselines['leads-at-high/lm'], frozen);
  assert.deepEqual(out.newFlags, ['leads-at-high/lm@2026-10-10']);
});

// ----- leadRoutingDeniesPer100Spawns -------------------------------------------------------

// A day of n lead rows at eff plus `deny` routing denials of session s-<day>; denial at the time of row 5.
function denyDay(day, n, deny, eff) {
  const rows = leadDay(day, n, 0, eff);
  const dens = [];
  for (let i = 0; i < deny; i++) dens.push({ at: at(day, 5), session_id: `s-${day}-${eff}`, tool_name: 'Agent', guard: i % 2 ? 'warrant' : 'fit', outcome: 'deny' });
  return { rows, dens };
}
const dtrig = (o = {}) => trig('leadRoutingDeniesPer100Spawns', o);

test('routing denies: normal. only fit/warrant/premium-cap/inherit denies count, per 100 lead rows of the effort', () => {
  const pre = PRE_DAYS.map((d) => denyDay(d, 20, 1, 'xhigh')); // 5 per 100
  const post = POST_DAYS.map((d) => denyDay(d, 20, 4, 'high')); // 20 per 100
  const noise = [{ at: at('2026-10-10', 5), session_id: 's-2026-10-10-high', guard: 'delegation', outcome: 'deny' }, { at: at('2026-10-10', 5), session_id: 's-2026-10-10-high', guard: 'fit', outcome: 'warn' }];
  const out = drive(dtrig(), { spawnRows: [...pre, ...post].flatMap((x) => x.rows), denialRows: [...pre, ...post].flatMap((x) => x.dens).concat(noise) });
  assert.ok(Math.abs(out.base.pooled - 5) < 1e-9);
  assert.ok(Math.abs(out.rec.value - 4) < 1e-9, `ratio ${out.rec.value}`);
  assert.deepEqual(out.newFlags, ['leads-at-high/lm@2026-10-10']);
});

test('routing denies: a denial takes the effort of its session (a xhigh session denial does not count for high)', () => {
  const t = dtrig({ baseline: undefined, post: undefined, minSample: 1, minDays: 1, threshold: -1 });
  const a = denyDay('2026-10-10', 10, 2, 'high'); const b = denyDay('2026-10-10', 10, 3, 'xhigh');
  const v = evalMetric({ decision: {}, trigger: t, key: 'k', history: [], spawnRows: [...a.rows, ...b.rows], denialRows: [...a.dens, ...b.dens], nowT: NOW, state: emptyState(), activeFromMs: null });
  assert.equal(v.days.find((d) => d.qualifies).value, 20, '2 denials over 10 high lead rows');
});

test('routing denies: thin sample, gap day and frozen baseline', () => {
  const pre = PRE_DAYS.map((d) => denyDay(d, 20, 1, 'xhigh'));
  const thin = POST_DAYS.map((d) => denyDay(d, 5, 4, 'high'));
  const o1 = drive(dtrig(), { spawnRows: [...pre, ...thin].flatMap((x) => x.rows), denialRows: [...pre, ...thin].flatMap((x) => x.dens) });
  assert.deepEqual(o1.newFlags, [], 'post days of 5 rows are below minPerDay');
  // gap: a zero-unit history day (usage lockout) is skipped, not read as 0 denials
  const post = POST_DAYS.map((d) => denyDay(d, 20, 4, 'high'));
  const zero = { v: 1, day: '2026-10-10', units: { main: 0, subagent: 0, total: 0 }, spawns: { total: 0, byType: {}, byRung: {} }, subagent: { compactions: 0, unitsOver150k: 0 }, ceilingNudges: 0 };
  const all = [...pre, ...post];
  const o2 = drive(dtrig({ minDays: 1 }), { history: [zero], spawnRows: all.flatMap((x) => x.rows), denialRows: all.flatMap((x) => x.dens) });
  assert.equal(o2.rec.lastDay, '2026-10-11', '10-10 was a gap');
  // frozen
  const state = emptyState();
  drive(dtrig(), { spawnRows: [...pre, post[0]].flatMap((x) => x.rows), denialRows: [...pre, post[0]].flatMap((x) => x.dens), state, nowT: T('2026-10-11T10:00:00Z') });
  const frozen = clone(state.baselines['leads-at-high/lm']);
  const o3 = drive(dtrig(), { spawnRows: post.flatMap((x) => x.rows), denialRows: post.flatMap((x) => x.dens), state });
  assert.deepEqual(state.baselines['leads-at-high/lm'], frozen);
  assert.deepEqual(o3.newFlags, ['leads-at-high/lm@2026-10-10']);
});

// ----- leadUnderProvisionedShare -----------------------------------------------------------

function fitDay(day, n, under, eff, extra = {}) {
  return leadDay(day, n, 0, eff).map((r, i) => ({ ...r, fit: i < under ? 'under' : (i % 2 ? 'over' : 'fit'), ...extra }));
}
const utrig = (o = {}) => trig('leadUnderProvisionedShare', { minSample: 15, baseline: { mode: 'pre-window', ratio: true, preDays: 5, minPerDay: 10, levels: ['xhigh'] }, ...o });

test('under-provisioned: normal. share of declared scored rows; undeclared and unscored rows are out', () => {
  const pre = PRE_DAYS.flatMap((d) => fitDay(d, 20, 2, 'xhigh')); // 10%
  const post = POST_DAYS.flatMap((d) => fitDay(d, 20, 6, 'high')); // 30%
  const noise = POST_DAYS.flatMap((d) => fitDay(d, 10, 10, 'high', { declared_type: null }).map((r) => ({ ...r, tool_use_id: `n-${r.tool_use_id}`, at: at(d, 50) })));
  const out = drive(utrig(), { spawnRows: [...pre, ...post, ...noise] });
  assert.ok(Math.abs(out.base.pooled - 10) < 1e-9);
  assert.ok(Math.abs(out.rec.value - 3) < 1e-9, `ratio ${out.rec.value}`);
  assert.deepEqual(out.newFlags, ['leads-at-high/lm@2026-10-10']);
});

test('under-provisioned: thin sample, gap day and frozen baseline', () => {
  const pre = PRE_DAYS.flatMap((d) => fitDay(d, 20, 2, 'xhigh'));
  const thin = POST_DAYS.flatMap((d) => fitDay(d, 6, 6, 'high'));
  assert.deepEqual(drive(utrig(), { spawnRows: [...pre, ...thin] }).newFlags, [], 'post days of 6 rows are below minPerDay 10');
  // a day with no scored rows (fit missing) is a gap, then two real days flag
  const unscored = fitDay('2026-10-10', 20, 6, 'high').map((r) => ({ ...r, fit: null }));
  const o2 = drive(utrig(), { spawnRows: [...pre, ...unscored, ...fitDay('2026-10-11', 20, 6, 'high'), ...fitDay('2026-10-12', 20, 6, 'high')], nowT: T('2026-10-13T10:00:00Z') });
  assert.equal(o2.rec.streak, 2);
  assert.deepEqual(o2.newFlags, ['leads-at-high/lm@2026-10-11']);
  const state = emptyState();
  drive(utrig(), { spawnRows: [...pre, ...fitDay('2026-10-10', 20, 6, 'high')], state, nowT: T('2026-10-11T10:00:00Z') });
  const frozen = clone(state.baselines['leads-at-high/lm']);
  const o3 = drive(utrig(), { spawnRows: POST_DAYS.flatMap((d) => fitDay(d, 20, 6, 'high')), state });
  assert.deepEqual(state.baselines['leads-at-high/lm'], frozen);
  assert.deepEqual(o3.newFlags, ['leads-at-high/lm@2026-10-10']);
});

// ----- mainUnitsPerLeadSpawn ---------------------------------------------------------------

function mday(day, main, spawns, total = main + 20) {
  return { v: 1, day, units: { main, subagent: total - main, total }, spawns: { total: spawns, byType: {}, byRung: {} }, subagent: { compactions: 0, unitsOver150k: 0 }, ceilingNudges: 0 };
}
const mtrig = (o = {}) => trig('mainUnitsPerLeadSpawn', { minSample: 20, baseline: { mode: 'pre-window', ratio: true, preDays: 5, minPerDay: 10 }, ...o });

test('main units per spawn: normal. 0.6 per spawn before, 1.2 after: ratio 2', () => {
  const history = [...PRE_DAYS.map((d) => mday(d, 18, 30)), mday('2026-10-10', 36, 30), mday('2026-10-11', 36, 30)];
  const out = drive(mtrig(), { history });
  assert.ok(Math.abs(out.base.pooled - 0.6) < 1e-9);
  assert.ok(Math.abs(out.rec.value - 2) < 1e-9);
  assert.deepEqual(out.newFlags, ['leads-at-high/lm@2026-10-10']);
});

test('main units per spawn: thin sample, gap day (zero units, no spawns) and frozen baseline', () => {
  const pre = PRE_DAYS.map((d) => mday(d, 18, 30));
  assert.deepEqual(drive(mtrig(), { history: [...pre, mday('2026-10-10', 30, 6), mday('2026-10-11', 30, 6)] }).newFlags, [], 'post days of 6 spawns are below minPerDay');
  const lockout = mday('2026-10-10', 0, 0, 0);
  const o2 = drive(mtrig({ minDays: 1 }), { history: [...pre, lockout, mday('2026-10-11', 36, 30), mday('2026-10-12', 36, 30)], nowT: T('2026-10-13T10:00:00Z') });
  assert.equal(o2.rec.lastDay, '2026-10-12');
  assert.equal(o2.rec.streak, 2);
  assert.ok(!o2.state.triggers['leads-at-high/lm'].episodeStart || o2.state.triggers['leads-at-high/lm'].episodeStart === '2026-10-11', 'the lockout day is skipped');
  const state = emptyState();
  drive(mtrig(), { history: [...pre, mday('2026-10-10', 36, 30)], state, nowT: T('2026-10-11T10:00:00Z') });
  const frozen = clone(state.baselines['leads-at-high/lm']);
  const o3 = drive(mtrig(), { history: [mday('2026-10-10', 36, 30), mday('2026-10-11', 36, 30)], state });
  assert.deepEqual(state.baselines['leads-at-high/lm'], frozen);
  assert.deepEqual(o3.newFlags, ['leads-at-high/lm@2026-10-10']);
});
