// Edge cases of scheduled config (0.31.7), from the writer's review: every one
// is a way a typo or a half-written schedule could switch something ON early,
// swap a route, or lower a review it should not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const rp = await import('../hooks/lib/routing-profile.mjs');
const rules = await import('../hooks/lib/rules.mjs');

const ROLLOUT = join(fx.stateDir, 'rollout.json');
const CONFIG = join(fx.stateDir, 'config');
const PROFILE = join(CONFIG, 'routing-profile.json');
const PAST = '2000-01-01T00:00:00Z';
const FUTURE = '2999-01-01T00:00:00Z';
const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;
function setRollout(obj) {
  mkdirSync(fx.stateDir, { recursive: true });
  writeFileSync(ROLLOUT, JSON.stringify(obj));
}
const row = (extra = {}) => ({
  state: 'trial', model: 'sonnet', effort: 'high', cacheTtl: null, source: 'operator-observed',
  since: '2026-10-09', reviewBy: '2026-12-23', waivesFloor: null, note: 'test', provenance: null, ...extra,
});
function writeProfile(rows) {
  mkdirSync(CONFIG, { recursive: true });
  writeFileSync(PROFILE, JSON.stringify({
    schema: 'agent-companion/routing-profile', schemaVersion: 1, revision: 16,
    basedOn: { tableVersion: 7, tableUpdated: '2026-09-23' }, objective: 'api-cost', planUsageMultipliers: null, types: {}, rows,
  }, null, 2));
  rp._resetProfileCache();
}
const sessionStart = () => rules.matchRules({ scope: 'session-start' }).map((r) => r.then);

test('a rule whose activeFrom is present but unusable is held OFF, never run as unscheduled', () => {
  setRollout({});
  for (const bad of [20261011, '', '   ', true, ['x'], {}]) {
    writeFileSync(rules.rulesPath(), JSON.stringify([{ id: 'sched-bad', scope: 'session-start', then: 'BAD-SCHEDULE-TEXT', activeFrom: bad }]));
    assert.ok(!sessionStart().includes('BAD-SCHEDULE-TEXT'), `activeFrom ${JSON.stringify(bad)} must not switch the rule on`);
    const listed = rules.readRules().rules.find((r) => r.id === 'sched-bad');
    assert.equal(listed.scheduleInvalid, true);
  }
  // null is "no schedule" (writeRules emits nulls for unset keys): active.
  writeFileSync(rules.rulesPath(), JSON.stringify([{ id: 'sched-null', scope: 'session-start', then: 'NULL-SCHEDULE-TEXT', activeFrom: null }]));
  assert.ok(sessionStart().includes('NULL-SCHEDULE-TEXT'));
  // A rewrite of the file (an /ac rules edit) keeps an unusable schedule OFF.
  writeFileSync(rules.rulesPath(), JSON.stringify([{ id: 'sched-bad', scope: 'session-start', then: 'BAD-SCHEDULE-TEXT', activeFrom: 7 }]));
  assert.ok(rules.writeRules(rules.readRules()));
  assert.ok(!sessionStart().includes('BAD-SCHEDULE-TEXT'));
  rmSync(rules.rulesPath(), { force: true });
});

test('a new rule written as enabled:false + after:{enabled:true} is off before the date and on from it (and off for a reader that ignores both keys)', () => {
  const RULE = { id: 'sched-form', scope: 'session-start', then: 'FORM-TEXT', enabled: false, activeFrom: 'sched-form', after: { enabled: true } };
  writeFileSync(rules.rulesPath(), JSON.stringify([RULE]));
  setRollout({ 'sched-form': FUTURE });
  assert.ok(!sessionStart().includes('FORM-TEXT'));
  setRollout({ 'sched-form': PAST });
  assert.ok(sessionStart().includes('FORM-TEXT'));
  // Without activeFrom/after (an older reader) the stored form is simply off.
  writeFileSync(rules.rulesPath(), JSON.stringify([{ id: 'sched-form', scope: 'session-start', then: 'FORM-TEXT', enabled: false }]));
  assert.ok(!sessionStart().includes('FORM-TEXT'));
  rmSync(rules.rulesPath(), { force: true });
});

test('profile row: activeFrom without `after` is a row that does not exist yet', () => {
  setRollout({ 'new-row': FUTURE });
  writeProfile({ 'bounded-feature': row({ model: 'sonnet', effort: 'low', activeFrom: 'new-row' }) });
  const before = ctx.resolveRoute({ type: 'bounded-feature' });
  assert.notEqual(label(before), 'sonnet/low', 'the scheduled row is not used early');
  assert.equal(before.profileStatus, 'ok');
  setRollout({ 'new-row': PAST });
  assert.equal(label(ctx.resolveRoute({ type: 'bounded-feature' })), 'sonnet/low');
  rmSync(PROFILE, { force: true });
  rp._resetProfileCache();
});

test('profile row: an `after` that makes the row unusable does not swap the route; the stored row stays', () => {
  setRollout({ chg: PAST });
  for (const after of [{ model: 'fable' }, { effort: 'bogus' }, { model: 'no-such-tier' }]) {
    writeProfile({ 'bounded-feature': row({ activeFrom: 'chg', after }) });
    const r = ctx.resolveRoute({ type: 'bounded-feature' });
    assert.equal(r.layer, 'profile', JSON.stringify(after));
    assert.equal(label(r), 'sonnet/high', JSON.stringify(after));
  }
  // A good overlay still applies, and an overlay cannot rewrite the schedule keys.
  writeProfile({ 'bounded-feature': row({ activeFrom: 'chg', after: { effort: 'medium', activeFrom: 'other', after: {} } }) });
  assert.equal(label(ctx.resolveRoute({ type: 'bounded-feature' })), 'sonnet/medium');
  rmSync(PROFILE, { force: true });
  rp._resetProfileCache();
});

test('reviewerEffortCap stops at the elevated effort floor', () => {
  setRollout({ cap: PAST });
  const tiers = ctx.modelTiers();
  const saved = tiers.reviewerEffortCap;
  tiers.reviewerEffortCap = { opus: { effort: 'low', activeFrom: 'cap' } };
  try {
    const at = (consequence) => label(ctx.resolveRoute({
      type: 'code-review', writer: { model: 'opus', effort: 'xhigh' }, ...(consequence ? { consequence, consequenceExplicit: true } : {}),
    }));
    assert.equal(at(null), 'opus/low', 'routine: the cap applies as set');
    assert.equal(at('elevated'), 'opus/high', 'elevated: clamped to the elevated floor (high)');
    assert.equal(at('critical'), 'opus/xhigh', 'critical: never capped');
  } finally {
    tiers.reviewerEffortCap = saved;
  }
});

test('AGENT_COMPANION_FAKE_NOW moves the rollout clock when no `now` is passed', () => {
  setRollout({ chg: '2026-10-14T08:00:00Z' });
  const was = process.env.AGENT_COMPANION_FAKE_NOW;
  try {
    process.env.AGENT_COMPANION_FAKE_NOW = '2026-10-14T07:59:59Z';
    assert.equal(ctx.rolloutActive('chg'), false);
    process.env.AGENT_COMPANION_FAKE_NOW = '2026-10-14T08:00:00Z';
    assert.equal(ctx.rolloutActive('chg'), true);
  } finally {
    if (was === undefined) delete process.env.AGENT_COMPANION_FAKE_NOW; else process.env.AGENT_COMPANION_FAKE_NOW = was;
  }
});

test('the context-ceiling reader and the config reader agree on every shape in the one shared rollout.json', async () => {
  const ceiling = await import('../hooks/lib/context-ceiling.mjs');
  const now = Date.parse('2026-10-14T08:00:00Z');
  const shapes = {
    z: '2026-10-14T08:00:00Z', offset: '2026-10-14T10:00:00+02:00', zoneless: '2026-10-14T08:00:00',
    future: '2026-10-14T08:00:01Z', junk: 'tomorrow', num: 5, empty: '',
  };
  setRollout(shapes);
  for (const id of Object.keys(shapes)) {
    assert.equal(ctx.rolloutActive(id, now), ceiling.rolloutActive(id, now), `reader mismatch for ${id}`);
  }
});
