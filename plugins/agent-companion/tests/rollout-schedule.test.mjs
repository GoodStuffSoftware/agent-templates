// Scheduled config (0.31.7): a routing-profile row, a standing rule or a
// reviewerEffortCap entry may carry `activeFrom` (a zoned UTC timestamp or a
// change id looked up in <stateRoot>/rollout.json). Until it is reached the
// config behaves as today; from that moment the change applies, with nobody
// flipping anything. An unresolvable `activeFrom` counts as NOT yet reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, runScript } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const rp = await import('../hooks/lib/routing-profile.mjs');
const rules = await import('../hooks/lib/rules.mjs');

const ROLLOUT = join(fx.stateDir, 'rollout.json');
const CONFIG = join(fx.stateDir, 'config');
const PROFILE = join(CONFIG, 'routing-profile.json');
const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;
const T0 = '2026-10-10T07:59:59Z'; // one second before the change
const T1 = '2026-10-10T08:00:00Z'; // the moment it takes effect

function setRollout(obj) {
  mkdirSync(fx.stateDir, { recursive: true });
  if (obj === null) rmSync(ROLLOUT, { force: true });
  else writeFileSync(ROLLOUT, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

test('rollout helpers: no spec is active; a timestamp and an id resolve; anything unresolvable is not yet active', () => {
  setRollout(null);
  assert.equal(ctx.rolloutPath(), ROLLOUT);
  assert.equal(ctx.rolloutActive(undefined, T0), true);
  assert.equal(ctx.rolloutActive(null, T0), true);
  assert.equal(ctx.rolloutActive('', T0), true);
  // A timestamp needs no file.
  assert.equal(ctx.rolloutActive('2026-10-10T08:00:00Z', T0), false);
  assert.equal(ctx.rolloutActive('2026-10-10T08:00:00Z', T1), true);
  assert.equal(ctx.rolloutActive('2026-10-10T10:00:00+02:00', T1), true, 'an offset timestamp is the same instant');
// No zone reads as UTC (the same as the context-ceiling hook's reader of the  // same file); an impossible date or time does not parse and is never active.  assert.equal(ctx.rolloutActive('2026-10-10T08:00:00', T0), false);  assert.equal(ctx.rolloutActive('2026-10-10T08:00:00', T1), true);  assert.equal(ctx.rolloutActive('2026-13-45T99:00:00Z', '2030-01-01T00:00:00Z'), false);  assert.equal(ctx.rolloutActive('2026-02-31T08:00:00Z', '2030-01-01T00:00:00Z'), false, 'Feb 31 does not roll into March');  assert.equal(ctx.rolloutActive('2026-10-10T24:00:00Z', '2030-01-01T00:00:00Z'), false);
  // An id with no file: not active, and no throw.
  assert.equal(ctx.rolloutActive('some-change', '2030-01-01T00:00:00Z'), false);
  setRollout({ 'some-change': '2026-10-10T08:00:00Z', 'zone-less': '2026-10-10T08:00:00', 'bad-day': '2026-02-31T08:00:00Z', 'not-a-string': 5 });
  assert.equal(ctx.rolloutActive('some-change', T0), false);
  assert.equal(ctx.rolloutActive('some-change', T1), true);
  assert.equal(ctx.rolloutActive('zone-less', T0), false);
  assert.equal(ctx.rolloutActive('zone-less', T1), true, 'a zone-less entry is UTC');
  assert.equal(ctx.rolloutActive('bad-day', '2030-01-01T00:00:00Z'), false);
  assert.equal(ctx.rolloutActive('not-a-string', '2030-01-01T00:00:00Z'), false);
  assert.equal(ctx.rolloutActive('unlisted', '2030-01-01T00:00:00Z'), false);
  // Garbage file: not active, no throw.
  setRollout('{ not json');
  assert.equal(ctx.rolloutActive('some-change', '2030-01-01T00:00:00Z'), false);
  // The schedule is re-read when the file changes (no restart to move a date).
  setRollout({ 'some-change': '2026-10-12T08:00:00Z' });
  assert.equal(ctx.rolloutActive('some-change', T1), false);
  setRollout({ 'some-change': '2026-10-10T08:00:00Z' });
  assert.equal(ctx.rolloutActive('some-change', T1), true);
});

// --- change 1: a routing-profile row with an `after` overlay --------------------

const row = (extra = {}) => ({
  state: 'trial', model: 'sonnet', effort: 'high', cacheTtl: null, source: 'operator-observed',
  since: '2026-10-09', reviewBy: '2026-12-23', waivesFloor: null, note: 'test', provenance: null, ...extra,
});
const profile = (rows) => ({
  schema: 'agent-companion/routing-profile', schemaVersion: 1, revision: 16,
  basedOn: { tableVersion: 7, tableUpdated: '2026-09-23' }, objective: 'api-cost', planUsageMultipliers: null,
  types: {}, rows,
});
function writeProfile(p) {
  mkdirSync(CONFIG, { recursive: true });
  writeFileSync(PROFILE, JSON.stringify(p, null, 2));
  rp._resetProfileCache();
}

test('profile row: base until activeFrom, then the `after` overlay (sonnet/high -> sonnet/medium)', () => {
  setRollout({ 'bounded-feature-medium': '2026-10-10T08:00:00Z' });
  writeProfile(profile({ 'bounded-feature': row({ activeFrom: 'bounded-feature-medium', after: { effort: 'medium' } }) }));
  const before = ctx.resolveRoute({ type: 'bounded-feature', now: T0 });
  const after = ctx.resolveRoute({ type: 'bounded-feature', now: T1 });
  assert.equal(before.layer, 'profile');
  assert.equal(label(before), 'sonnet/high');
  assert.equal(after.layer, 'profile');
  assert.equal(label(after), 'sonnet/medium');
  // A date moved later in the schedule file moves the switch with it.
  setRollout({ 'bounded-feature-medium': '2026-10-11T08:00:00Z' });
  assert.equal(label(ctx.resolveRoute({ type: 'bounded-feature', now: T1 })), 'sonnet/high');
  // An unresolvable id never switches early.
  setRollout(null);
  assert.equal(label(ctx.resolveRoute({ type: 'bounded-feature', now: '2031-01-01T00:00:00Z' })), 'sonnet/high');
});

test('profile row: activeFrom/after are accepted by the validator, bad shapes are not', () => {
  setRollout({ x: '2026-10-10T08:00:00Z' });
  writeProfile(profile({ 'bounded-feature': row({ activeFrom: 'x', after: { effort: 'medium' } }) }));
  assert.equal(ctx.resolveRoute({ type: 'bounded-feature', now: T1 }).profileStatus, 'ok');
  assert.deepEqual(rp.rowShapeErrors(row({ activeFrom: 'x', after: { effort: 'medium' } })), []);
  assert.ok(rp.rowShapeErrors(row({ activeFrom: 5 })).some((e) => /activeFrom/.test(e)));
  assert.ok(rp.rowShapeErrors(row({ activeFrom: '  ' })).some((e) => /activeFrom/.test(e)));
  assert.ok(rp.rowShapeErrors(row({ activeFrom: 'x', after: 'medium' })).some((e) => /after/.test(e)));
  rp._resetProfileCache();
});

// --- change 2: the Opus non-critical reviewer cap ---------------------------------

const CAP = { opus: { effort: 'high', activeFrom: 'opus-review-high', exceptWriterTypes: ['novel-design', 'critical-change'] } };
const review = (writer, { consequence, writerType, now = T1 } = {}) => {
  const [model, effort] = writer.split('/');
  return ctx.resolveRoute({
    type: 'code-review', writer: { model, effort: effort || '' }, now, writerType: writerType || null,
    ...(consequence ? { consequence, consequenceExplicit: true } : {}),
  });
};

test('reviewerEffortCap: an opus/xhigh writer\'s non-critical review is opus/high from activeFrom, opus/xhigh before', () => {
  setRollout({ 'opus-review-high': '2026-10-11T08:00:00Z' });
  const tiers = ctx.modelTiers();
  const saved = tiers.reviewerEffortCap;
  tiers.reviewerEffortCap = CAP;
  try {
    assert.equal(label(review('opus/xhigh', { now: '2026-10-11T07:59:59Z' })), 'opus/xhigh');
    const r = review('opus/xhigh', { now: '2026-10-11T08:00:00Z' });
    assert.equal(label(r), 'opus/high');
    assert.ok(r.floorsApplied.some((f) => f.floor === 'F3' && f.capped), 'the cap is recorded as a floor note');
    assert.equal(label(review('opus/max', { now: '2026-10-11T08:00:00Z' })), 'opus/high');
    // Never raises a lower writer's effort, never touches another model.
    assert.equal(label(review('opus/medium', { now: '2026-10-11T08:00:00Z' })), 'opus/medium');
    assert.equal(label(review('opus/high', { now: '2026-10-11T08:00:00Z' })), 'opus/high');
    assert.equal(label(review('sonnet/high', { now: '2026-10-11T08:00:00Z' })), 'sonnet/high');
    assert.equal(label(review('sonnet/xhigh', { now: '2026-10-11T08:00:00Z' })), 'sonnet/xhigh');
    // Critical stays at the floor.
    assert.equal(label(review('opus/xhigh', { consequence: 'critical', now: '2026-10-11T08:00:00Z' })), 'opus/xhigh');
    assert.equal(label(review('sonnet/low', { consequence: 'critical', now: '2026-10-11T08:00:00Z' })), 'opus/xhigh');
    // A writer of an excepted type keeps full parity.
    assert.equal(label(review('opus/xhigh', { writerType: 'novel-design', now: '2026-10-11T08:00:00Z' })), 'opus/xhigh');
    assert.equal(label(review('opus/xhigh', { writerType: 'critical-change', now: '2026-10-11T08:00:00Z' })), 'opus/xhigh');
    assert.equal(label(review('opus/xhigh', { writerType: 'bounded-feature', now: '2026-10-11T08:00:00Z' })), 'opus/high');
  } finally {
    tiers.reviewerEffortCap = saved;
  }
});

test('reviewerEffortCap: shipped empty means unchanged parity; a cap naming an unsupported or unknown effort is ignored', () => {
  setRollout({ 'opus-review-high': '2026-10-11T08:00:00Z' });
  const tiers = ctx.modelTiers();
  const saved = tiers.reviewerEffortCap;
  try {
    tiers.reviewerEffortCap = {};
    assert.equal(label(review('opus/xhigh', { now: '2030-01-01T00:00:00Z' })), 'opus/xhigh');
    tiers.reviewerEffortCap = { opus: { effort: 'turbo', activeFrom: 'opus-review-high' } };
    assert.equal(label(review('opus/xhigh', { now: '2030-01-01T00:00:00Z' })), 'opus/xhigh');
    tiers.reviewerEffortCap = { opus: { effort: 'high', activeFrom: 'no-such-id' } };
    assert.equal(label(review('opus/xhigh', { now: '2030-01-01T00:00:00Z' })), 'opus/xhigh', 'unresolvable id = not yet active');
    tiers.reviewerEffortCap = 'garbage';
    assert.equal(label(review('opus/xhigh', { now: '2030-01-01T00:00:00Z' })), 'opus/xhigh');
  } finally {
    tiers.reviewerEffortCap = saved;
  }
});

test('recommend.mjs: --writer-type reaches the cap (the recommender and the guard agree)', () => {
  const f = makeFixture();
  try {
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(join(f.stateDir, 'model-tiers.json'), JSON.stringify({
      reviewerEffortCap: { opus: { effort: 'high', activeFrom: 'opus-review-high', exceptWriterTypes: ['novel-design'] } },
    }));
    const run = (args, date) => { writeFileSync(join(f.stateDir, 'rollout.json'), JSON.stringify({ 'opus-review-high': date })); return runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'opus/xhigh', '--json', ...args], {
      cwd: f.dir, env: {},
    }); };
    const early = run([], '2999-01-01T00:00:00Z');
    assert.equal(early.status, 0, early.stderr);
    assert.equal(`${early.json.model}/${early.json.effort}`, 'opus/xhigh');
    const late = run([], '2000-01-01T00:00:00Z');
    assert.equal(late.status, 0, late.stderr);
    assert.equal(`${late.json.model}/${late.json.effort}`, 'opus/high');
    const excepted = run(['--writer-type', 'novel-design'], '2000-01-01T00:00:00Z');
    assert.equal(`${excepted.json.model}/${excepted.json.effort}`, 'opus/xhigh');
    const critical = run(['--consequence', 'critical'], '2000-01-01T00:00:00Z');
    assert.equal(`${critical.json.model}/${critical.json.effort}`, 'opus/xhigh');
  } finally {
    f.cleanup();
  }
});

// --- changes 3 and 4: standing rules ------------------------------------------------

test('rules: activeFrom without `after` is OFF until reached, then ON; with `after` the overlay applies from then', () => {
  setRollout({ 'option-b-recheck': '2026-10-13T08:00:00Z', 'leads-high': '2026-10-12T08:00:00Z' });
  const RULE_NEW = { id: 'recheck-test', scope: 'session-start', then: 'RECHECK-TEXT', activeFrom: 'option-b-recheck' };
  const RULE_LEAD = {
    id: 'lead-effort-check', enabled: true, activeFrom: 'leads-high', after: { then: 'HIGH-TEXT' },
  };
  writeFileSync(rules.rulesPath(), JSON.stringify([RULE_NEW, RULE_LEAD]));
  const texts = (now) => {
    // matchRules reads the real clock; move the schedule instead of the clock.
    return rules.matchRules({ scope: 'session-start' }).map((r) => r.then);
  };
  // Real clock is past every date used above, so move the dates to the future
  // and the past to build the before/after states.
  setRollout({ 'option-b-recheck': '2999-01-01T00:00:00Z', 'leads-high': '2999-01-01T00:00:00Z' });
  let t = texts();
  assert.ok(!t.includes('RECHECK-TEXT'), 'a scheduled new rule is off before its date');
  assert.ok(t.includes(rules.LEAD_EFFORT_CHECK_TEXT), 'the lead rule keeps today\'s text before its date');
  assert.ok(!t.includes('HIGH-TEXT'));
  setRollout({ 'option-b-recheck': '2000-01-01T00:00:00Z', 'leads-high': '2000-01-01T00:00:00Z' });
  t = texts();
  assert.ok(t.includes('RECHECK-TEXT'), 'a scheduled new rule is on once its date is reached');
  assert.ok(t.includes('HIGH-TEXT'), 'the overlay text applies once reached');
  assert.ok(!t.includes(rules.LEAD_EFFORT_CHECK_TEXT));
  // An unresolvable id never switches on or overlays.
  setRollout(null);
  t = texts();
  assert.ok(!t.includes('RECHECK-TEXT'));
  assert.ok(t.includes(rules.LEAD_EFFORT_CHECK_TEXT));
  rmSync(rules.rulesPath(), { force: true });
});

test('rules: writeRules/readRules round-trip keeps activeFrom and after', () => {
  writeFileSync(rules.rulesPath(), JSON.stringify([
    { id: 'rt-new', scope: 'session-start', then: 'T', activeFrom: 'some-id', after: { enabled: false } },
    { id: 'lead-effort-check', enabled: true, activeFrom: 'leads-high', after: { then: 'HIGH' } },
  ]));
  const before = rules.readRules();
  assert.ok(rules.writeRules({ version: rules.RULES_VERSION, rules: before.rules }));
  const after = rules.readRules().rules;
  const nu = after.find((r) => r.id === 'rt-new');
  assert.equal(nu.activeFrom, 'some-id');
  assert.deepEqual(nu.after, { enabled: false });
  const lead = after.find((r) => r.id === 'lead-effort-check');
  assert.equal(lead.activeFrom, 'leads-high');
  assert.deepEqual(lead.after, { then: 'HIGH' });
  rmSync(rules.rulesPath(), { force: true });
});

// --- the SessionStart hook end to end (sandbox state dir) ---------------------------

test('SessionStart hook: the lead rule says xhigh before leads-high and high after', () => {
  const f = makeFixture();
  try {
    mkdirSync(f.stateDir, { recursive: true });
    const highText = rules.LEAD_EFFORT_CHECK_TEXT.replaceAll('xhigh', 'high');
    writeFileSync(rules.rulesPath(), JSON.stringify([
      { id: 'lead-effort-check', enabled: true, activeFrom: 'leads-high', after: { then: highText } },
    ]));
    const run = (date) => {
      writeFileSync(join(f.stateDir, 'rollout.json'), JSON.stringify({ 'leads-high': date }));
      const res = runHook('hooks/standing-rules.mjs', { session_id: 'sr-1', hook_event_name: 'SessionStart', source: 'startup' }, {
        args: ['--event', 'session-start'], env: {},
      });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout;
    };
    const early = run('2999-01-01T00:00:00Z');
    assert.match(early, /an orchestration lead runs at xhigh/);
    const late = run('2000-01-01T00:00:00Z');
    assert.match(late, /an orchestration lead runs at high\b/);
    assert.doesNotMatch(late, /runs at xhigh/);
  } finally {
    f.cleanup();
  }
});
