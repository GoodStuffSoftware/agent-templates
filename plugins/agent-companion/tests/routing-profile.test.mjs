// ADR 0003 slice 2: the routing profile as the RESOLVER sees it — layer 1 of
// resolveRoute(). Fixture profiles (valid; invalid JSON; bad schema; a higher
// major version; hand-edited rows breaking each of F1-F4; the F5 waiver with
// and without operator-observed; a code-review row naming a model; a row
// naming fable), local types, the kill switch, fail-open, telemetry and the
// state-root-only rule. Hermetic: every path is under makeFixture()'s temp
// home; the shipped table is used as-is (no per-machine override file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeFixture, runHook, runScript, readJsonl, PLUGIN_ROOT } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const rp = await import('../hooks/lib/routing-profile.mjs');

const BEFORE = '2026-09-24T12:00:00Z';
const AFTER = '2026-10-20T12:00:00Z'; // haiku's retiresAfter has passed
const CONFIG = join(fx.stateDir, 'config');
const PROFILE = join(CONFIG, 'routing-profile.json');
const MARKER = join(fx.stateDir, 'state', 'routing-profile-invalid.json');
const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;

const row = (model, effort, extra = {}) => ({
  state: 'trial', model, effort, cacheTtl: null, source: 'operator-observed',
  since: '2026-09-24', reviewBy: '2026-12-23', waivesFloor: null, note: 'PRIVATE-NOTE-TEXT', provenance: null, ...extra,
});
const profile = (rows, extra = {}) => ({
  schema: 'agent-companion/routing-profile', schemaVersion: 1, revision: 7,
  basedOn: { tableVersion: 7, tableUpdated: '2026-09-23' }, objective: 'api-cost', planUsageMultipliers: null,
  types: {}, rows, ...extra,
});
function writeProfile(p) {
  mkdirSync(CONFIG, { recursive: true });
  writeFileSync(PROFILE, typeof p === 'string' ? p : JSON.stringify(p, null, 2));
  rp._resetProfileCache();
}
function clearProfile() {
  rmSync(PROFILE, { recursive: true, force: true });
  rp._resetProfileCache();
}
// The shipped answer, the profile never consulted.
const shipped = (args) => ctx.resolveRoute({ ...args, profile: false });

test('the profile and every file beside it live under the state root, never the plugin dir or a repo', () => {
  assert.equal(ctx.routingProfilePath(), PROFILE);
  assert.equal(ctx.routingProfileInvalidMarkerPath(), MARKER);
  assert.ok(!relative(fx.stateDir, ctx.routingProfilePath()).startsWith('..'));
  assert.ok(relative(PLUGIN_ROOT, ctx.routingProfilePath()).startsWith('..'), 'profile path must not be inside the plugin dir');
});

test('no profile: every shipped type resolves exactly as with the profile layer off (the acceptance gate)', () => {
  clearProfile();
  for (const type of Object.keys(ctx.modelTiers().taskTypes)) {
    for (const now of [BEFORE, AFTER]) {
      const args = { type, now, writer: type === 'code-review' ? { model: 'sonnet', effort: 'high' } : null };
      const a = ctx.resolveRoute(args);
      const b = shipped(args);
      assert.deepEqual([label(a), a.layer, a.rationale, a.floorsApplied, a.skipped], [label(b), b.layer, b.rationale, b.floorsApplied, b.skipped], type);
      assert.equal(a.profileStatus, 'absent');
      assert.equal(a.profileRevision, null);
      assert.equal(a.stack[0].status, 'absent');
    }
  }
  assert.equal(existsSync(MARKER), false, 'no marker without a profile');
});

test('valid profile: an operator row wins layer 1, shadows the trial and the grid, and explains itself', () => {
  writeProfile(profile({ 'bounded-feature': row('sonnet', 'medium') }));
  const r = ctx.resolveRoute({ type: 'bounded-feature', now: BEFORE });
  assert.equal(r.layer, 'profile');
  assert.equal(label(r), 'sonnet/medium');
  assert.equal(r.profileRevision, 7);
  assert.equal(r.profileStatus, 'ok');
  assert.equal(r.source, 'operator-observed');
  assert.equal(r.state, 'trial');
  assert.equal(r.trial, null);
  assert.deepEqual(r.stack.map((s) => s.status), ['won', 'shadowed', 'shadowed']);
  assert.doesNotMatch(r.rationale, /PRIVATE-NOTE-TEXT/, 'the note never enters the rationale');
  const lines = ctx.explainRoute(r).join('\n');
  assert.match(lines, /profile\s+won\s+sonnet\/medium/);
  assert.match(lines, /winner:\s+profile -> sonnet\/medium \(the type was resolved as-is and its routing-profile row \(trial, operator-observed\) passed F1-F4\)/);
  assert.match(lines, /provenance: profile rev 7, operator-observed, no n or CI recorded, trial since 2026-09-24, review by 2026-12-23/);
  // Other types are untouched.
  const o = ctx.resolveRoute({ type: 'debug-root-cause', now: BEFORE });
  assert.equal(o.layer, 'trial');
  assert.equal(o.profileRevision, 7);
});

test('adopted rows apply; retired rows never resolve', () => {
  writeProfile(profile({
    'bounded-feature': row('sonnet', 'high', { state: 'adopted' }),
    operate: row('sonnet', 'low', { state: 'retired' }),
  }));
  assert.equal(ctx.resolveRoute({ type: 'bounded-feature', now: BEFORE }).layer, 'profile');
  const r = ctx.resolveRoute({ type: 'operate', now: BEFORE });
  assert.equal(r.layer, 'trial');
  assert.equal(r.stack[0].status, 'retired');
  assert.equal(label(r), label(shipped({ type: 'operate', now: BEFORE })));
});

test('a departing explicit weight/kind/consequence skips the profile row; one equal to the preset keeps it', () => {
  writeProfile(profile({ 'bounded-feature': row('sonnet', 'medium') }));
  const dep = ctx.resolveRoute({ type: 'bounded-feature', weight: 2, weightExplicit: true, now: BEFORE });
  assert.equal(dep.layer, 'grid');
  assert.match(dep.skipped.find((s) => s.layer === 'profile').reason, /departs from the bounded-feature preset/);
  const same = ctx.resolveRoute({ type: 'bounded-feature', weight: 3, weightExplicit: true, now: BEFORE });
  assert.equal(same.layer, 'profile');
});

test('the cacheTtl hint and benchmark provenance ride through to the result and the explain line', () => {
  writeProfile(profile({
    'bounded-feature': row('opus', 'low', {
      source: 'benchmark', cacheTtl: '1h',
      provenance: { runs: ['r1'], measuredAt: '2026-09-23', n: 12, packs: 4, pass: { k: 12, n: 12, ci95: [0.76, 1.0] }, costIndex: 0.9 },
    }),
  }));
  const r = ctx.resolveRoute({ type: 'bounded-feature', now: BEFORE });
  assert.equal(r.cacheTtl, '1h');
  assert.equal(r.provenance.n, 12);
  assert.equal(ctx.routeProvenanceLine(r), 'profile rev 7, benchmark, 12/12 pass, CI 76-100%, 4 packs, cost 0.90x, measured 2026-09-23, trial since 2026-09-24, review by 2026-12-23');
});

// --- Invalid files fail open, as a whole, and leave a marker ---------------

for (const [name, text, reason] of [
  ['invalid JSON', '{ "schema": "agent-companion/routing-profile", "rows": { PRIVATE-NOTE-TEXT', 'parse'],
  ['a bad schema (rows is an array)', JSON.stringify(profile([])), 'schema'],
  ['a bad schema (wrong schema id)', JSON.stringify(profile({}, { schema: 'something-else' })), 'schema'],
  ['a bad schema (revision missing)', JSON.stringify({ ...profile({}), revision: undefined }), 'schema'],
  ['a higher major schemaVersion', JSON.stringify(profile({ 'bounded-feature': row('sonnet', 'medium') }, { schemaVersion: 2 })), 'version'],
]) {
  test(`${name}: ignored as a whole, the shipped table answers, and the invalid marker records it`, () => {
    writeProfile(text);
    for (const type of ['bounded-feature', 'integration', 'critical-change']) {
      let r;
      assert.doesNotThrow(() => { r = ctx.resolveRoute({ type, now: BEFORE }); });
      const s = shipped({ type, now: BEFORE });
      assert.deepEqual([label(r), r.layer], [label(s), s.layer], type);
      assert.equal(r.profileStatus, 'invalid');
      assert.equal(r.profileError, reason);
      assert.equal(r.profileRevision, null);
      assert.equal(r.stack[0].status, 'invalid');
      assert.match(ctx.explainRoute(r).join('\n'), /profile ignored as a whole/);
    }
    const m = JSON.parse(readFileSync(MARKER, 'utf8'));
    assert.equal(m.signal, 'routing_profile_invalid');
    assert.equal(m.reason, reason);
    assert.doesNotMatch(JSON.stringify(m), /PRIVATE-NOTE-TEXT|sonnet/, 'the marker carries no file content');
    // Fixing the file clears the marker on the next read.
    writeProfile(profile({}));
    ctx.resolveRoute({ type: 'bounded-feature', now: BEFORE });
    assert.equal(existsSync(MARKER), false);
  });
}

test('an unreadable profile (a directory where the file should be) fails open without throwing', () => {
  clearProfile();
  mkdirSync(PROFILE, { recursive: true });
  rp._resetProfileCache();
  try {
    const r = ctx.resolveRoute({ type: 'bounded-feature', now: BEFORE });
    assert.equal(r.profileStatus, 'invalid');
    assert.equal(r.layer, 'trial');
  } finally { clearProfile(); }
});

// --- Hand-edited rows that break F1-F4 are ignored at read ------------------

const IGNORED = [
  ['F1 (model): critical-change on sonnet', 'critical-change', row('sonnet', 'xhigh'), /^F1: critical consequence needs at least opus/],
  ['F1 (effort): critical-change on opus/high', 'critical-change', row('opus', 'high'), /^F1: critical consequence needs effort at least xhigh/],
  ['F2: a row naming fable', 'bounded-feature', row('fable', 'high'), /^F2: fable is never a routing destination/],
  ['F2: a premium tier ranked at or above fable (mythos)', 'bounded-feature', row('mythos', 'high'), /^F2: mythos/],
  ['F3: a code-review row naming a model', 'code-review', row('opus', 'high'), /^F3: a code-review row may set only a minimum effort, never a model/],
  ['F4: an unknown alias', 'bounded-feature', row('gpt-x', 'high'), /^hard-stale \(F4\): 'gpt-x' is not a tier alias/],
  ['F4: a dated model id instead of an alias', 'bounded-feature', row('claude-opus-5-5', 'high'), /is not a tier alias/],
  ['F4: an effort the model does not take (haiku/low)', 'explore', row('haiku', 'low'), /^hard-stale \(F4\): effort 'low' unsupported by haiku/],
  ['F4: a model that takes an effort, with none named', 'bounded-feature', row('opus', null), /^hard-stale \(F4\): opus takes an effort parameter/],
  ['a row with an invalid state', 'bounded-feature', row('sonnet', 'medium', { state: 'proposed' }), /^invalid row: state must be one of/],
  ['a waiver of a floor other than elevated', 'integration', row('sonnet', 'low', { waivesFloor: 'critical' }), /^invalid row: waivesFloor may only be null or "elevated"/],
];
for (const [name, type, r0, why] of IGNORED) {
  test(`hand-edited row, ${name}: ignored at read, recorded in skipped, shipped answer stands`, () => {
    writeProfile(profile({ [type]: r0 }));
    const writer = type === 'code-review' ? { model: 'sonnet', effort: 'high' } : null;
    const r = ctx.resolveRoute({ type, now: BEFORE, writer });
    const s = shipped({ type, now: BEFORE, writer });
    assert.notEqual(r.layer, 'profile');
    assert.deepEqual([label(r), r.layer], [label(s), s.layer]);
    assert.equal(r.stack[0].status, 'skipped');
    const sk = r.skipped.find((x) => x.layer === 'profile');
    assert.ok(sk, JSON.stringify(r.skipped));
    assert.match(sk.reason, why);
    assert.equal(r.profileStatus, 'ok', 'one bad row does not invalidate the file');
  });
}

test('F4 by date: a haiku row is hard-stale once haiku retires, and applies before', () => {
  writeProfile(profile({ explore: row('haiku', null) }));
  assert.equal(ctx.resolveRoute({ type: 'explore', now: BEFORE }).layer, 'profile');
  const after = ctx.resolveRoute({ type: 'explore', now: AFTER });
  assert.notEqual(after.layer, 'profile');
  assert.match(after.skipped.find((x) => x.layer === 'profile').reason, /^hard-stale \(F4\): haiku is unavailable or retired/);
});

test('hard-stale: a row whose type exists nowhere is skipped and says so', () => {
  writeProfile(profile({ 'no-such-type': row('sonnet', 'medium') }));
  const r = ctx.resolveRoute({ type: 'no-such-type', weight: 3, weightExplicit: true, now: BEFORE });
  assert.equal(r.layer, 'grid');
  assert.match(r.skipped.find((x) => x.layer === 'profile').reason, /^hard-stale: task type 'no-such-type' exists in neither/);
});

test('the trial layer gets the same alias checks (review finding A): unknown alias or empty effort is skipped', async () => {
  // A synthetic trial via the per-machine override file, in its own process
  // (modelTiers() caches the table per process).
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    mkdirSync(stateDir, { recursive: true });
    const trial = (model, effort) => ({ model, effort, reason: 'synthetic', trialSince: '2026-09-24', reviewBy: '2026-10-01' });
    writeFileSync(join(stateDir, 'model-tiers.json'), JSON.stringify({
      taskTypes: {
        'x-alien': { weight: 3, kind: 'bounded', consequence: 'routine', override: trial('gpt-x', 'high') },
        'x-noeffort': { weight: 3, kind: 'bounded', consequence: 'routine', override: trial('opus', '') },
      },
    }));
    const a = runScript('scripts/recommend.mjs', ['--type', 'x-alien', '--explain', '--json'], { env: { AGENT_COMPANION_STATE_DIR: stateDir, AGENT_COMPANION_HOME_OVERRIDE: dir } });
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.json.route.layer, 'grid');
    assert.match(a.json.route.skipped[0].reason, /^F4: 'gpt-x' is not a tier alias/);
    const b = runScript('scripts/recommend.mjs', ['--type', 'x-noeffort', '--explain', '--json'], { env: { AGENT_COMPANION_STATE_DIR: stateDir, AGENT_COMPANION_HOME_OVERRIDE: dir } });
    assert.equal(b.json.route.layer, 'grid');
    assert.match(b.json.route.skipped[0].reason, /^F4: opus takes an effort parameter/);
  } finally { cleanup(); }
});

// --- F5: waivable only by an operator-observed row, always explained --------

test('F5 waiver on an operator-observed row: the effort stays below the elevated floor, and explain says so', () => {
  writeProfile(profile({ integration: row('sonnet', 'medium', { waivesFloor: 'elevated' }) }));
  const r = ctx.resolveRoute({ type: 'integration', now: BEFORE });
  assert.equal(r.layer, 'profile');
  assert.equal(label(r), 'sonnet/medium');
  assert.deepEqual(r.floorsApplied.map((f) => [f.floor, !!f.waived]), [['F5', true]]);
  assert.deepEqual([r.waiver.honored, r.waiver.applies], [true, true]);
  const lines = ctx.explainRoute(r).join('\n');
  assert.match(lines, /floors:\s+F5 waived: effort medium kept below high/);
  assert.match(lines, /waiver:\s+F5 elevated effort floor — HONOURED/);
});

test('F5 waiver on a non-operator row is ignored: F5 raises the effort, and explain prints the ignored waiver', () => {
  writeProfile(profile({ integration: row('sonnet', 'medium', { waivesFloor: 'elevated', source: 'benchmark' }) }));
  const r = ctx.resolveRoute({ type: 'integration', now: BEFORE });
  assert.equal(r.layer, 'profile');
  assert.equal(label(r), 'sonnet/high');
  assert.deepEqual(r.floorsApplied.map((f) => [f.floor, f.raised]), [['F5', 'effort medium -> high']]);
  assert.equal(r.waiver.honored, false);
  assert.match(ctx.explainRoute(r).join('\n'), /waiver:\s+F5 elevated effort floor — IGNORED: waiver ignored: source benchmark is not operator-observed/);
});

test('without a waiver, F5 raises a hand-edited elevated row below high (floors after the winning layer)', () => {
  writeProfile(profile({ integration: row('sonnet', 'low') }));
  const r = ctx.resolveRoute({ type: 'integration', now: BEFORE });
  assert.equal(r.layer, 'profile');
  assert.equal(label(r), 'sonnet/high');
  assert.equal(r.waiver, null);
});

// S2 review P5 (lead decision): a code-review row's minimum effort can only
// RAISE effort, so it applies even when the consequence departs; a critical
// review never gets less effort than a routine one.
test('a code-review minimum effort still applies when the consequence departs (critical)', () => {
  writeProfile(profile({ 'code-review': row(null, 'max') }));
  const writer = { model: 'sonnet', effort: 'high' };
  const routine = ctx.resolveRoute({ type: 'code-review', writer, now: BEFORE });
  const critical = ctx.resolveRoute({ type: 'code-review', writer, consequence: 'critical', consequenceExplicit: true, now: BEFORE });
  assert.deepEqual([routine.layer, label(routine)], ['profile', 'sonnet/max']);
  assert.deepEqual([critical.layer, label(critical)], ['profile', 'opus/max']);
  // Any other departure still skips the row.
  const kind = ctx.resolveRoute({ type: 'code-review', writer, kind: 'mechanical', kindExplicit: true, now: BEFORE });
  assert.equal(kind.layer, 'grid');
  assert.match(kind.skipped.find((x) => x.layer === 'profile').reason, /explicit kind departs from the code-review preset/);
});

// S2 review P4: a hand-edited effort matched case-insensitively but was
// used verbatim ("HIGH"); it is lower-cased at read time.
test('a hand-edited upper-case effort is used lower-cased', () => {
  writeProfile(profile({ 'bounded-feature': row('sonnet', 'HIGH') }));
  const r = ctx.resolveRoute({ type: 'bounded-feature', now: BEFORE });
  assert.deepEqual([r.layer, label(r)], ['profile', 'sonnet/high']);
  writeProfile(profile({ 'code-review': row(null, 'XHigh') }));
  const cr = ctx.resolveRoute({ type: 'code-review', writer: { model: 'sonnet', effort: 'high' }, now: BEFORE });
  assert.deepEqual([cr.layer, label(cr)], ['profile', 'sonnet/xhigh']);
});

// S2 review P2: raiseEffort() cannot raise a model that takes no effort, so
// a haiku row on an elevated type used to skip F5 entirely. Such a model
// counts as BELOW the floor: the row is skipped unless it carries an honoured
// waiver, and when it does, the waived floor is recorded.
test('F5: a haiku row on an elevated type is skipped without an honoured waiver', () => {
  for (const extra of [{}, { waivesFloor: 'elevated', source: 'benchmark' }]) {
    writeProfile(profile({ 'large-refactor': row('haiku', null, extra) }));
    const r = ctx.resolveRoute({ type: 'large-refactor', now: BEFORE });
    assert.notEqual(r.layer, 'profile', JSON.stringify(extra));
    assert.match(r.skipped.find((x) => x.layer === 'profile').reason, /^F5: haiku takes no effort parameter, so it cannot meet the elevated floor \(high\)/);
  }
});

test('F5: a haiku row on an elevated type with an honoured waiver applies, and the waived floor is recorded', () => {
  writeProfile(profile({ 'large-refactor': row('haiku', null, { waivesFloor: 'elevated' }) }));
  const r = ctx.resolveRoute({ type: 'large-refactor', now: BEFORE });
  assert.equal(r.layer, 'profile');
  assert.equal(label(r), 'haiku');
  assert.deepEqual(r.floorsApplied.map((f) => [f.floor, !!f.waived]), [['F5', true]]);
  // A routine type is unaffected: haiku there needs no waiver.
  writeProfile(profile({ verify: row('haiku', null) }));
  assert.equal(ctx.resolveRoute({ type: 'verify', now: BEFORE }).layer, 'profile');
});

test('a waiver never reaches F1: a critical declaration still floors a waiving row (or ignores it)', () => {
  writeProfile(profile({ integration: row('sonnet', 'medium', { waivesFloor: 'elevated' }) }));
  const r = ctx.resolveRoute({ type: 'integration', consequence: 'critical', now: BEFORE });
  assert.ok(r.model === 'opus' && ['xhigh', 'max'].includes(r.effort), label(r));
});

// --- code-review: a minimum effort on top of writer parity (F3) -------------

test('a code-review row sets a minimum effort over writer parity, never the model', () => {
  writeProfile(profile({ 'code-review': row(null, 'xhigh') }));
  const up = ctx.resolveRoute({ type: 'code-review', writer: { model: 'sonnet', effort: 'high' }, now: BEFORE });
  assert.deepEqual([label(up), up.layer], ['sonnet/xhigh', 'profile']);
  const met = ctx.resolveRoute({ type: 'code-review', writer: { model: 'opus', effort: 'max' }, now: BEFORE });
  assert.deepEqual([label(met), met.layer], ['opus/max', 'profile']);
  assert.match(met.rationale, /already met/);
  const hk = ctx.resolveRoute({ type: 'code-review', writer: { model: 'haiku', effort: '' }, now: BEFORE });
  assert.equal(hk.layer, 'grid');
  assert.match(hk.skipped.find((x) => x.layer === 'profile').reason, /^F4: minimum effort 'xhigh' unsupported by the writer's model haiku/);
});

// A code-review row combined with a fable writer: F2 caps fable to opus in
// parityFloors() before the row is ever consulted, so the row's minimum
// effort can only RAISE what F2 already produced, never below it and never
// onto a different model (a row can never name one for a parity type; see F3
// in profileRowRefusal).
test('a code-review row raises on top of F2 for a fable writer, never below it and never off-model', () => {
  // Below the F2-capped effort: the floor wins outright ("already met").
  writeProfile(profile({ 'code-review': row(null, 'low') }));
  const met = ctx.resolveRoute({ type: 'code-review', writer: { model: 'fable', effort: 'low' }, now: BEFORE });
  assert.deepEqual([label(met), met.layer], ['opus/low', 'profile']);
  assert.match(met.rationale, /already met/);
  assert.ok(met.floorsApplied.some((f) => f.floor === 'F2' && /fable -> opus/.test(f.capped)));

  // Above it: the row raises further, still on the F2-capped model (opus).
  writeProfile(profile({ 'code-review': row(null, 'xhigh') }));
  const raised = ctx.resolveRoute({ type: 'code-review', writer: { model: 'fable', effort: 'low' }, now: BEFORE });
  assert.deepEqual([label(raised), raised.layer], ['opus/xhigh', 'profile']);
  assert.match(raised.rationale, /sets a minimum effort xhigh -> opus\/xhigh/);
  assert.equal(raised.model, 'opus', 'the profile row never moves the model off the F2-capped opus');
});

// FLIPPED by S2 review P5 (lead decision). An EXPLICIT critical consequence
// departs from code-review's own preset (weight "parity", consequence
// "inherit"), and it used to skip the profile layer entirely. A code-review
// row only sets a MINIMUM effort, applied after F3/F4/F2/F1 have floored
// the answer, so it can never soften a critical, fable-capped review; it can
// only raise it. It therefore still applies: a minimum below the floor is
// "already met", one above it raises the effort. F1/F2 still govern the model.
test('an explicit critical consequence keeps the code-review row: F1/F2 floor a fable writer, the row can only raise', () => {
  for (const [minEffort, want] of [['low', 'opus/xhigh'], ['max', 'opus/max']]) {
    writeProfile(profile({ 'code-review': row(null, minEffort) }));
    const r = ctx.resolveRoute({
      type: 'code-review', writer: { model: 'fable', effort: 'low' }, consequence: 'critical', consequenceExplicit: true, now: BEFORE,
    });
    assert.deepEqual([label(r), r.layer], [want, 'profile'], `row minEffort ${minEffort}`);
    assert.equal(r.model, 'opus', 'the row never moves the model off the F2-capped opus');
    assert.ok(r.floorsApplied.some((f) => f.floor === 'F2' && /fable -> opus/.test(f.capped)));
    assert.ok(r.floorsApplied.some((f) => f.floor === 'F1' && /effort low -> xhigh/.test(f.raised)));
    assert.equal(r.skipped.find((x) => x.layer === 'profile'), undefined);
  }
});

// --- User-local types --------------------------------------------------------

test('local types: TYPE resolves shipped first, then local; a local type never carries a trial', () => {
  writeProfile(profile({ 'git-plumbing': row('sonnet', 'high') }, {
    types: {
      'git-plumbing': { weight: 2, kind: 'mechanical', consequence: 'elevated', summary: 'git plumbing', origin: 'manual', createdAt: '2026-09-24' },
      'bare-local': { weight: 3, kind: 'bounded', consequence: 'routine', override: { model: 'fable', effort: 'max' } },
      integration: { weight: 1, kind: 'mechanical', consequence: 'routine' },
      'bad-kind': { weight: 2, kind: 'nope', consequence: 'routine' },
    },
  }));
  const r = ctx.resolveRoute({ type: 'git-plumbing', now: BEFORE });
  assert.deepEqual([r.typeKnown, r.typeOrigin, r.layer, label(r)], [true, 'local', 'profile', 'sonnet/high']);
  const bare = ctx.resolveRoute({ type: 'bare-local', now: BEFORE });
  assert.equal(bare.layer, 'grid', 'an override on a local type is never a trial');
  assert.equal(label(bare), label(ctx.resolveRoute({ weight: 3, kind: 'bounded', consequence: 'routine', now: BEFORE })));
  const shadow = ctx.resolveRoute({ type: 'integration', now: BEFORE });
  assert.deepEqual([shadow.typeOrigin, shadow.weight], ['shipped', 4], 'the shipped definition wins a name collision');
  assert.equal(ctx.resolveRoute({ type: 'bad-kind', now: BEFORE }).typeKnown, false);
  assert.deepEqual(ctx.taskTypeNames().filter((n) => !ctx.modelTiers().taskTypes[n]), ['git-plumbing', 'bare-local']);
});

// --- Kill switch ---------------------------------------------------------------

test('kill switch: routing_profile off means the shipped table only, and the file is not touched', () => {
  writeProfile(profile({ 'bounded-feature': row('sonnet', 'medium') }));
  const before = statSync(PROFILE);
  const bytes = readFileSync(PROFILE, 'utf8');
  process.env.CLAUDE_PLUGIN_OPTION_ROUTING_PROFILE = 'false';
  try {
    const r = ctx.resolveRoute({ type: 'bounded-feature', now: BEFORE });
    assert.deepEqual([r.layer, r.profileStatus, r.profileRevision, r.stack[0].status], ['trial', 'off', null, 'off']);
    assert.equal(label(r), label(shipped({ type: 'bounded-feature', now: BEFORE })));
    // An invalid file under the kill switch is not even read: no marker.
    rmSync(MARKER, { force: true });
    writeProfile('not json');
    const inv = ctx.resolveRoute({ type: 'bounded-feature', now: BEFORE });
    assert.equal(inv.profileStatus, 'off');
    assert.equal(existsSync(MARKER), false);
  } finally { delete process.env.CLAUDE_PLUGIN_OPTION_ROUTING_PROFILE; }
  writeProfile(bytes);
  assert.equal(readFileSync(PROFILE, 'utf8'), bytes);
  assert.ok(before.size === statSync(PROFILE).size);
  // Back on: the row applies again from the next call.
  assert.equal(ctx.resolveRoute({ type: 'bounded-feature', now: BEFORE }).layer, 'profile');
});

test('kill switch from settings.json (outside a hook), and from the next hook invocation', () => {
  writeProfile(profile({ 'bounded-feature': row('sonnet', 'medium') }));
  const bytes = readFileSync(PROFILE, 'utf8');
  const mtime = statSync(PROFILE).mtimeMs;
  const spawn = (sid, env) => runHook('hooks/spawn-guard.mjs', {
    session_id: sid, agent_type: 'main', cwd: fx.dir,
    tool_input: { subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true, name: 'w', prompt: 'TYPE: bounded-feature\ngo' },
  }, { env: { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...env } });
  spawn('sess-ks-on', {});
  spawn('sess-ks-off', { CLAUDE_PLUGIN_OPTION_ROUTING_PROFILE: 'false' });
  const rows = Object.fromEntries(readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl')).map((r) => [r.session_id, r]));
  assert.deepEqual([rows['sess-ks-on'].route_layer, rows['sess-ks-on'].route_profile_rev], ['profile', 7]);
  assert.deepEqual([rows['sess-ks-off'].route_layer, rows['sess-ks-off'].route_profile_rev], ['trial', null]);
  assert.equal(readFileSync(PROFILE, 'utf8'), bytes);
  assert.equal(statSync(PROFILE).mtimeMs, mtime);

  mkdirSync(join(fx.dir, '.claude'), { recursive: true });
  writeFileSync(join(fx.dir, '.claude', 'settings.json'), JSON.stringify({ pluginConfigs: { 'agent-companion@agent-templates': { options: { routing_profile: false } } } }));
  try {
    const res = runScript('scripts/recommend.mjs', ['--type', 'bounded-feature', '--explain', '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.route.layer, 'trial');
  } finally { rmSync(join(fx.dir, '.claude', 'settings.json'), { force: true }); }
});

// --- Telemetry and the spawn guard ---------------------------------------------

test('telemetry: route_layer "profile" and route_profile_rev when a row wins; row content is never logged', () => {
  writeProfile(profile({ 'bounded-feature': row('sonnet', 'medium'), 'git-plumbing': row('sonnet', 'high') }, {
    types: { 'git-plumbing': { weight: 2, kind: 'mechanical', consequence: 'elevated' } },
  }));
  const spawn = (sid, prompt, model) => runHook('hooks/spawn-guard.mjs', {
    session_id: sid, agent_type: 'main', cwd: fx.dir,
    tool_input: { subagent_type: 'general-purpose', model, run_in_background: true, name: 'w', prompt },
  }, { env: { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
  const fit = spawn('sess-prof-fit', 'TYPE: bounded-feature\ngo', 'sonnet');
  const under = spawn('sess-prof-under', 'TYPE: bounded-feature\ngo', 'haiku');
  spawn('sess-prof-local', 'TYPE: git-plumbing\ngo', 'sonnet');
  spawn('sess-prof-other', 'TYPE: debug-root-cause\ngo', 'opus');
  const rows = Object.fromEntries(readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl')).map((r) => [r.session_id, r]));
  assert.deepEqual([rows['sess-prof-fit'].route_layer, rows['sess-prof-fit'].route_profile_rev, rows['sess-prof-fit'].fit], ['profile', 7, 'fit']);
  assert.deepEqual([rows['sess-prof-local'].declared_type, rows['sess-prof-local'].route_layer], ['git-plumbing', 'profile']);
  assert.deepEqual([rows['sess-prof-other'].route_layer, rows['sess-prof-other'].route_profile_rev], ['trial', null]);
  assert.match(under.json?.systemMessage || '', /\[route layer: routing profile rev 7\]/);
  assert.equal(fit.status, 0);
  const tdir = join(fx.stateDir, 'telemetry');
  for (const f of readdirSync(tdir)) {
    assert.doesNotMatch(readFileSync(join(tdir, f), 'utf8'), /PRIVATE-NOTE-TEXT|operator-observed|2026-12-23/, `${f} must not carry row content`);
  }
});

test('a routed opus profile row makes opus warrant-free for that type, like a trial; fable never is', () => {
  writeProfile(profile({ 'mechanical-edit': row('opus', 'medium') }));
  const spawn = (sid, model) => runHook('hooks/spawn-guard.mjs', {
    session_id: sid, agent_type: 'main', cwd: fx.dir,
    tool_input: { subagent_type: 'general-purpose', model, run_in_background: true, name: 'w', prompt: 'TYPE: mechanical-edit\ngo' },
  }, { env: { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
  const ok = spawn('sess-prof-opus', 'opus');
  assert.notEqual(ok.json?.hookSpecificOutput?.permissionDecision, 'deny', ok.stdout);
  const fable = spawn('sess-prof-fable', 'fable');
  assert.equal(fable.json?.hookSpecificOutput?.permissionDecision, 'deny', 'fable still needs its warrant');
});

test('recommend --list and --type see local types; routing-table stays shipped unless --profile', () => {
  writeProfile(profile({ 'bounded-feature': row('sonnet', 'medium') }, {
    types: { 'git-plumbing': { weight: 2, kind: 'mechanical', consequence: 'elevated', summary: 'git plumbing' } },
  }));
  const list = runScript('scripts/recommend.mjs', ['--list']);
  assert.match(list.stdout, /git-plumbing .*\(local\) git plumbing/);
  const rec = runScript('scripts/recommend.mjs', ['--type', 'git-plumbing', '--json']);
  assert.equal(rec.status, 0, rec.stderr);
  const doc = runScript('scripts/routing-table.mjs', []);
  assert.equal(doc.stdout.replace(/\r\n/g, '\n'), readFileSync(join(PLUGIN_ROOT, 'docs', 'ROUTING.md'), 'utf8').replace(/\r\n/g, '\n'),
    'the default table (committed as docs/ROUTING.md) never includes a profile');
  const mine = runScript('scripts/routing-table.mjs', ['--profile']);
  assert.match(mine.stdout, /`bounded-feature` \| 3 .*`sonnet\/medium` _\(your routing profile, rev 7\)_/);
});
