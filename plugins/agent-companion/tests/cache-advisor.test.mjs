// scripts/lib/cache-advisor.mjs — the break-even auto-compact window.
// Every fixture is SYNTHETIC: hand-built tracks, compactions, bench rows and
// transcripts in the shape the shared reader emits. No real transcript
// content, no model calls.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, PLUGIN_ROOT } from './helpers.mjs';

// The price and window tables are cached at module scope and merge a local
// copy from the state root, so the whole file runs inside one fixture: no test
// here can read the operator's real state.
const FILE_FIXTURE = makeFixture();
after(() => FILE_FIXTURE.cleanup());
import {
  parseWindow, configuredWindow, windowSpecFor, priceSpecFor, replayTrack, uncompactedPeak, closedFormWindow,
  candidateWindows, thresholdFor, evaluateModel, combineModels, emptyModelInput, postCompactionParams,
  calibrate, priceCheckFor, collectAdvisorInputs, runCacheAdvisor, formatAdvice, saveAdvisorSummary,
  loadAdvisorSummary, windowHintFor, summaryOf, spawnOverhead, compactionConfig, adviseFromInputs,
  settingsWindowValid, envWindow, ignoredWindowLines, isBenchProject, BENCH_DIR_PREFIXES, coverageOf, settingForms,
} from '../scripts/lib/cache-advisor.mjs';

// --- builders ------------------------------------------------------------------------

// A track in the collector's shape: `n` requests starting at `start`, each
// growing by `g` (or by inc[i] when an array is given).
function track({ start = 60000, g = 2000, n = 100, inc = null, kind = 'main', idleAt = [], ttl1h = null } = {}) {
  const incs = inc || [0, ...Array.from({ length: n - 1 }, () => g)];
  const len = incs.length;
  const t1 = ttl1h ?? (kind === 'main' ? 1 : 0);
  return {
    model: 'm', kind, start,
    inc: incs,
    idle: Array.from({ length: len }, (_, i) => (idleAt.includes(i) ? 1 : 0)),
    ttl1h: Array.from({ length: len }, () => t1),
  };
}

function modelInput(model, tracks, { compactions = [], mainTurns = 0, idle = 0 } = {}) {
  const mi = emptyModelInput(model);
  mi.tracks = tracks.map((t) => ({ ...t, model }));
  for (const t of mi.tracks) {
    mi.requests += t.inc.length;
    if (t.kind === 'main') mi.mainRequests += t.inc.length; else mi.subagentRequests += t.inc.length;
    for (let i = 1; i < t.inc.length; i++) { mi.growth.sum += t.inc[i]; mi.growth.n += 1; }
    mi.ttl1hSteps += t.ttl1h.reduce((a, b) => a + b, 0);
  }
  mi.compactions = compactions;
  mi.mainTurns = mainTurns;
  mi.idleExpiries = idle;
  return mi;
}

const comp = (kind = 'main', o = {}) => ({
  kind, trigger: 'auto', preTokens: 967000, postTokens: 20000, firstAfterContext: 60000, firstAfterWrite: 40000, requestsAfter: 100, reworkTokens: null, ...o,
});

const steadyParams = { P: 60000, Pw: 40000, S: 20000, r: 0.1, w5: 1.25, w1: 2, outRatio: 5, rework: 0 };

// =============================================================================
// The configured window (read-only)

test('parseWindow: the forms /autocompact accepts, and junk', () => {
  assert.equal(parseWindow('400k'), 400000);
  assert.equal(parseWindow('500K'), 500000);
  assert.equal(parseWindow('1M'), 1000000);
  assert.equal(parseWindow(400000), 400000);
  assert.equal(parseWindow('400000'), 400000);
  assert.equal(parseWindow('200'), 200000, 'a bare 100-1000 means thousands');
  assert.equal(parseWindow(200), 200000);
  assert.equal(parseWindow('abc'), null);
  assert.equal(parseWindow(null), null);
});

// Claude Code 2.1.280: the env var first (parseInt-style, clamped to 100K-1M,
// invalid ignored), then settings (managed > local > project > user), where a
// value failing number().int().min(100000).max(1000000) is dropped silently.
test('configuredWindow: env wins and is clamped; a string in settings is ignored, loudly; else unset', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const settingsPath = join(dir, 'settings.json');
    const managedPath = join(dir, 'managed-settings.json');
    writeFileSync(settingsPath, JSON.stringify({ autoCompactWindow: '400k' }));
    const str = configuredWindow({ env: {}, settingsPath, managedPath });
    assert.equal(str.tokens, null, 'the string "400k" is dropped by the schema: the default applies');
    assert.equal(str.source, 'unset');
    assert.deepEqual(str.ignored, [{ source: 'user settings autoCompactWindow', raw: '400k', reason: 'it must be an integer from 100000 to 1000000' }]);
    assert.match(ignoredWindowLines(str)[0], /"400k" is IGNORED by Claude Code: it must be an integer .*; each model's default applies/);
    const env = configuredWindow({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }, settingsPath, managedPath });
    assert.equal(env.tokens, 300000);
    assert.match(env.source, /env/);
    assert.match(ignoredWindowLines(env)[0], /300K from env CLAUDE_CODE_AUTO_COMPACT_WINDOW applies/);
    const k = configuredWindow({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k' }, settingsPath, managedPath });
    assert.equal(k.tokens, 100000, '"500k" reads as 500 and is clamped to the 100K minimum');
    assert.match(k.notes[0], /reads as 500 and is clamped to 100000/);
    assert.equal(configuredWindow({ env: {}, settingsPath: join(dir, 'missing.json'), managedPath }).source, 'unset');
    // Read-only: the settings file is byte-identical afterwards.
    assert.equal(readFileSync(settingsPath, 'utf8'), JSON.stringify({ autoCompactWindow: '400k' }));
  } finally { cleanup(); }
});

test('settingsWindowValid / envWindow: the schema and the env parse as Claude Code applies them', () => {
  for (const v of [100000, 275000, 1000000]) assert.equal(settingsWindowValid(v), true, String(v));
  for (const v of ['400k', '400000', 400, 99999, 1000001, 250000.5, null, true]) assert.equal(settingsWindowValid(v), false, String(v));
  assert.deepEqual(envWindow('300000'), { tokens: 300000, parsed: 300000, status: 'valid' });
  assert.equal(envWindow('5e5').tokens, 500000, 'scientific notation is a whole number');
  assert.equal(envWindow('500,000').tokens, 500000, 'thousands separators are read');
  assert.equal(envWindow('2000000').tokens, 1000000, 'capped at 1M');
  assert.equal(envWindow('1M').tokens, 100000, '"1M" reads as 1 and is raised to 100K');
  assert.equal(envWindow('abc').status, 'invalid');
  assert.equal(envWindow('0').status, 'invalid');
});

test('configuredWindow: precedence managed > local > project > user; an invalid value falls through to the next; flag and disable', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const proj = join(dir, 'proj');
    mkdirSync(join(proj, '.claude'), { recursive: true });
    const settingsPath = join(dir, 'user.json');
    const managedPath = join(dir, 'managed.json');
    writeFileSync(settingsPath, JSON.stringify({ autoCompactWindow: 400000 }));
    writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 350000 }));
    writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ autoCompactWindow: '300k' }));
    let c = configuredWindow({ env: {}, settingsPath, managedPath, projectDir: proj });
    assert.equal(c.tokens, 350000, 'the invalid local value is skipped; project settings apply');
    assert.equal(c.source, 'project settings autoCompactWindow');
    assert.equal(c.ignored.length, 1);
    assert.match(c.ignored[0].source, /local project settings/);
    assert.equal(configuredWindow({ env: {}, settingsPath, managedPath }).tokens, 400000, 'no projectDir: user settings');
    writeFileSync(managedPath, JSON.stringify({ autoCompactWindow: 500000 }));
    c = configuredWindow({ env: {}, settingsPath, managedPath, projectDir: proj });
    assert.equal(c.tokens, 500000);
    assert.match(c.source, /managed/);
    assert.equal(configuredWindow({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'abc' }, settingsPath, managedPath }).tokens, 500000, 'an invalid env value is ignored');
    assert.equal(configuredWindow({ env: {}, settingsPath, managedPath, flag: '275k' }).tokens, 275000, 'a flag the caller knows beats settings');
    assert.equal(configuredWindow({ env: {}, settingsPath, managedPath, flag: 'auto' }).tokens, null);
    assert.equal(configuredWindow({ env: { DISABLE_AUTO_COMPACT: '1' }, settingsPath, managedPath }).autoCompactDisabled, 'env DISABLE_AUTO_COMPACT');
    writeFileSync(settingsPath, JSON.stringify({ autoCompactEnabled: false }));
    assert.match(configuredWindow({ env: {}, settingsPath, managedPath: join(dir, 'none') }).autoCompactDisabled, /user settings/);
  } finally { cleanup(); }
});

// =============================================================================
// Model specs: 200K vs 1M

test('windowSpecFor: 1M models compact at about 967K by default, 200K models at about 167K; unknown is treated as 200K', () => {
  const o55 = windowSpecFor('claude-opus-5-5');
  assert.equal(o55.alias, 'opus-5-5');
  assert.equal(o55.contextWindow, 1000000);
  assert.equal(o55.defaultCompactAt, 967000);
  assert.equal(o55.reserve, 33000);
  assert.equal(windowSpecFor('claude-opus-5').alias, 'opus-5', 'opus-5 does not swallow opus-5-5 or the reverse');
  const h = windowSpecFor('claude-haiku-4-5-20251001');
  assert.equal(h.contextWindow, 200000);
  assert.equal(h.defaultCompactAt, 167000);
  const u = windowSpecFor('claude-unknown-9');
  assert.equal(u.known, false);
  assert.equal(u.contextWindow, 200000);
  assert.equal(u.defaultCompactAt, 167000);
});

test('candidateWindows / thresholdFor: settings run 100K to the context window; a setting compacts 33K below min(setting, context)', () => {
  const h = windowSpecFor('claude-haiku-4-5');
  assert.deepEqual(candidateWindows(h), [100000, 125000, 150000, 175000, 200000]);
  assert.equal(thresholdFor(400000, h), 167000, 'capped at 200K, then 33K below');
  assert.equal(thresholdFor(null, h), 167000, 'unset: the default');
  const s = windowSpecFor('claude-sonnet-5');
  const c = candidateWindows(s);
  assert.equal(c[0], 100000);
  assert.equal(c[c.length - 1], 1000000, 'the 1M setting (which compacts at the 967K default) is a candidate');
  assert.equal(thresholdFor(1000000, s), 967000);
  assert.equal(thresholdFor(275000, s), 242000);
  assert.equal(thresholdFor(null, s), 967000);
  assert.deepEqual(settingForms(275000), { settingsValue: 275000, command: '/autocompact 275k' });
});

// =============================================================================
// The replay: formula edge cases, computed by hand

test('replayTrack: no compaction below the threshold; cost is the sum of context reads', () => {
  const t = track({ start: 50, inc: [0, 50, 50] });
  const x = replayTrack(t, 1000, { ...steadyParams, P: 40, Pw: 10, S: 5 });
  assert.equal(x.compactions, 0);
  assert.ok(Math.abs(x.cost - (50 + 100 + 150) * 0.1) < 1e-9);
});

test('replayTrack: one compaction, priced as call read + summary output + rewrite of the new context', () => {
  const t = track({ start: 50, inc: [0, 50, 50, 50], kind: 'subagent' }); // 5m TTL: w = 1.25
  const p = { ...steadyParams, P: 40, Pw: 10, S: 5 };
  const x = replayTrack(t, 150, p);
  // 50*0.1 + 100*0.1 + [150*0.1 + 5*5 + 10*(1.25-0.1)] + 40*0.1 + 90*0.1
  assert.equal(x.compactions, 1);
  assert.ok(Math.abs(x.cost - 79.5) < 1e-9, `got ${x.cost}`);
  // An idle expiry on the last request rewrites its context instead of reading it.
  const idle = replayTrack({ ...t, idle: [0, 0, 0, 1] }, 150, p);
  assert.ok(Math.abs(idle.cost - (79.5 - 9 + 90 * 1.25)) < 1e-9, `got ${idle.cost}`);
  // Rework: the context after the compaction is P + rework, and the rework is written once.
  const rw = replayTrack(t, 150, { ...p, rework: 20 });
  assert.ok(Math.abs(rw.cost - (5 + 10 + (15 + 25 + 11.5 + 20 * 1.25) + 60 * 0.1 + 110 * 0.1)) < 1e-9, `got ${rw.cost}`);
  // A 1h track prices the rewrite at 2x.
  const h = replayTrack({ ...t, ttl1h: [1, 1, 1, 1] }, 150, p);
  assert.ok(Math.abs(h.cost - (79.5 - 11.5 + 10 * (2 - 0.1))) < 1e-9, `got ${h.cost}`);
});

test('replayTrack: a session that starts above the window compacts at once; shrinking context never goes negative', () => {
  const t = track({ start: 500, inc: [0, -1000, 10] });
  const x = replayTrack(t, 300, { ...steadyParams, P: 40, Pw: 0, S: 0 });
  assert.equal(x.compactions, 1);
  // 500 -> compact -> 40 read; then 40-1000 clamps to 0; then 10.
  assert.ok(Math.abs(x.cost - (500 * 0.1 + (40 * 0.1) + 0 + 10 * 0.1)) < 1e-9, `got ${x.cost}`);
  assert.equal(uncompactedPeak(track({ start: 10, inc: [0, 5, -100, 7] })), 15);
});

test('closedFormWindow: matches a brute-force minimum of its own cost function; null with no growth', () => {
  const p = { P: 60000, Pw: 40000, S: 20000, r: 0.1, wMean: 1.25, outRatio: 5, g: 2000, lambda: 0.01, rework: 10000 };
  const W = closedFormWindow(p);
  const R = p.r + p.lambda * (p.wMean - p.r);
  const P1 = p.P + p.rework;
  const k0 = p.S * p.outRatio + p.Pw * (p.wMean - p.r) + p.rework * p.wMean;
  const f = (w) => (R * (P1 + w)) / 2 + (p.g * (k0 + p.r * w)) / (w - P1);
  let best = null;
  for (let w = P1 + 100; w < 3e6; w += 100) if (!best || f(w) < f(best)) best = w;
  assert.ok(Math.abs(W - best) <= 200, `closed form ${W} vs brute force ${best}`);
  assert.equal(closedFormWindow({ ...p, g: 0 }), null);
});

test('replay and closed form agree on a long steady session (EOQ sanity check)', () => {
  const t = track({ start: 60000, g: 2000, n: 20000, kind: 'subagent' });
  const p = { ...steadyParams };
  let bestW = null;
  let bestCost = Infinity;
  for (let W = 80000; W <= 400000; W += 5000) {
    const x = replayTrack(t, W, p);
    if (x.cost < bestCost) { bestCost = x.cost; bestW = W; }
  }
  const W = closedFormWindow({ P: p.P, Pw: p.Pw, S: p.S, r: p.r, wMean: 1.25, outRatio: p.outRatio, g: 2000, lambda: 0 });
  assert.ok(Math.abs(bestW - W) <= 10000, `replay optimum ${bestW} vs closed form ${Math.round(W)}`);
});

// =============================================================================
// Parameters and statuses

test('postCompactionParams: this model and kind first, then this model, then everyone; null with fewer than 3 anywhere', () => {
  const a = modelInput('claude-sonnet-5', [], { compactions: [comp('main', { firstAfterContext: 70000 }), comp('main', { firstAfterContext: 80000 }), comp('main', { firstAfterContext: 90000 })] });
  const b = modelInput('claude-opus-5', [], { compactions: [comp('subagent', { firstAfterContext: 50000 })] });
  const all = new Map([[a.model, a], [b.model, b]]);
  const own = postCompactionParams('claude-sonnet-5', 'main', all);
  assert.equal(own.P, 80000);
  assert.equal(own.source, 'this model, this kind');
  assert.equal(postCompactionParams('claude-sonnet-5', 'subagent', all).source, 'this model');
  const pooled = postCompactionParams('claude-opus-5', 'main', all);
  assert.equal(pooled.source, 'all models, this kind');
  assert.equal(postCompactionParams('x', 'main', new Map([['x', modelInput('x', [], { compactions: [comp()] })]])), null);
});

test('postCompactionParams: rework is the pooled median, never negative, 0 with too few samples', () => {
  const cs = [comp('main', { reworkTokens: 30000 }), comp('main', { reworkTokens: -5000 }), comp('main', { reworkTokens: 10000 })];
  const all = new Map([['m', modelInput('m', [], { compactions: cs })]]);
  assert.equal(postCompactionParams('m', 'main', all).rework, 10000);
  const neg = new Map([['m', modelInput('m', [], { compactions: cs.map((c) => ({ ...c, reworkTokens: -1 })) })]]);
  assert.equal(postCompactionParams('m', 'main', neg).rework, 0);
  const few = new Map([['m', modelInput('m', [], { compactions: [comp(), comp(), comp('main', { reworkTokens: 99999 })] })]]);
  assert.equal(postCompactionParams('m', 'main', few).rework, 0);
});

const threeComps = [comp(), comp(), comp()];
const longTracks = (n = 6, o = {}) => Array.from({ length: n }, () => track({ start: 60000, g: 2000, n: 400, ...o }));

test('evaluateModel: insufficient data, window-insensitive and unpriced are said, never extrapolated', () => {
  const few = modelInput('claude-sonnet-5', [track({ n: 50 })], { compactions: threeComps });
  let e = evaluateModel(few, new Map([[few.model, few]]));
  assert.equal(e.status, 'insufficient-data');
  assert.match(e.reason, /requests/);
  assert.equal(e.optimum, undefined);

  const small = modelInput('claude-sonnet-5', Array.from({ length: 30 }, () => track({ start: 10000, g: 100, n: 100 })), { compactions: threeComps });
  e = evaluateModel(small, new Map([[small.model, small]]));
  assert.equal(e.status, 'window-insensitive', e.reason);

  const thin = modelInput('claude-sonnet-5', [...longTracks(2), ...Array.from({ length: 20 }, () => track({ start: 10000, g: 100, n: 100 }))], { compactions: threeComps });
  e = evaluateModel(thin, new Map([[thin.model, thin]]));
  assert.equal(e.status, 'insufficient-data');
  assert.match(e.reason, /session/);

  const noComp = modelInput('claude-sonnet-5', longTracks(6));
  e = evaluateModel(noComp, new Map([[noComp.model, noComp]]));
  assert.equal(e.status, 'insufficient-data');
  assert.match(e.reason, /compactions/);

  const unpriced = modelInput('claude-unknown-9', longTracks(6), { compactions: threeComps });
  assert.equal(evaluateModel(unpriced, new Map([[unpriced.model, unpriced]])).status, 'unpriced');
});

test('evaluateModel: one model, steady growth — optimum near the closed form, bands contain it, savings vs default', () => {
  const mi = modelInput('claude-sonnet-5', longTracks(6, { kind: 'subagent' }), { compactions: threeComps.map((c) => ({ ...c, kind: 'subagent' })) });
  const e = evaluateModel(mi, new Map([[mi.model, mi]]), { configured: 400000 });
  assert.equal(e.status, 'ok');
  assert.ok(Math.abs(e.optimum.window - e.closedFormWindow) <= 50000, `optimum ${e.optimum.window} closed form ${e.closedFormWindow}`);
  assert.ok(e.band1[0] <= e.optimum.window && e.optimum.window <= e.band1[1]);
  assert.ok(e.band5[0] <= e.band1[0] && e.band1[1] <= e.band5[1]);
  assert.ok(e.savingVsDefault.usd > 0);
  assert.equal(e.atConfigured.window, 400000);
  assert.ok(e.fit && Number.isFinite(e.fit.ratio));
  // Every point below the post-compaction size is marked infeasible, not priced.
  assert.ok(e.curve.every((c) => c.feasible === c.threshold > 60000));
});

test('evaluateModel: the turn floor lifts a window that would compact every few turns', () => {
  // 10 requests per turn, a 10-turn floor: at least 100 requests between compactions.
  const mi = modelInput('claude-sonnet-5', longTracks(6), { compactions: threeComps, mainTurns: 240 });
  const e = evaluateModel(mi, new Map([[mi.model, mi]]), { minTurnsPerCompaction: 10 });
  assert.equal(e.status, 'ok');
  assert.equal(e.params.requestsPerTurn, 10);
  assert.ok(e.unconstrainedOptimum.window < e.optimum.window, `${e.unconstrainedOptimum.window} < ${e.optimum.window}`);
  assert.ok(e.optimum.turnsPerCompaction >= 10);
  for (const c of e.curve.filter((x) => x.feasible && x.compactions)) assert.equal(c.allowed, c.turnsPerCompaction >= 10);
  const strict = evaluateModel(mi, new Map([[mi.model, mi]]), { minTurnsPerCompaction: 1e6 });
  // At the largest windows nothing compacts, so something is always allowed.
  assert.equal(strict.status, 'ok');
  assert.ok(strict.optimum.compactions === 0);
});

test('evaluateModel: a 200K model stops at the 200K setting, which compacts at its 167K default', () => {
  const mi = modelInput('claude-haiku-4-5', longTracks(6), { compactions: threeComps });
  const e = evaluateModel(mi, new Map([[mi.model, mi]]));
  assert.equal(e.status, 'ok');
  assert.equal(Math.max(...e.curve.map((c) => c.window)), 200000);
  assert.equal(e.curve.find((c) => c.window === 200000).threshold, 167000);
  assert.equal(e.atDefault.threshold, 167000);
  assert.equal(e.atDefault.usd, e.curve.find((c) => c.window === 200000).usd, 'unset costs what the 200K setting costs');
  // Every window is a setting; its compaction point is 33K below it.
  for (const c of e.curve) assert.equal(c.threshold, c.window - 33000);
  assert.equal(e.optimum.threshold, e.optimum.window - 33000);
});

// =============================================================================
// The one global value

test('combineModels: a one-model corpus recommends that model\'s own optimum', () => {
  const mi = modelInput('claude-sonnet-5', longTracks(6, { kind: 'subagent' }), { compactions: threeComps.map((c) => ({ ...c, kind: 'subagent' })) });
  const e = evaluateModel(mi, new Map([[mi.model, mi]]));
  const g = combineModels([e]);
  assert.equal(g.optimum.window, e.optimum.window);
  assert.deepEqual(g.voters, ['claude-sonnet-5']);
});

test('combineModels: a 200K model votes at its own cap above 200K; insufficient models do not vote', () => {
  const s = modelInput('claude-sonnet-5', longTracks(6), { compactions: threeComps });
  const h = modelInput('claude-haiku-4-5', longTracks(6), { compactions: threeComps });
  const all = new Map([[s.model, s], [h.model, h]]);
  const es = evaluateModel(s, all);
  const eh = evaluateModel(h, all);
  const thin = { model: 'claude-opus-5', status: 'insufficient-data' };
  const g = combineModels([es, eh, thin]);
  assert.deepEqual(g.voters, ['claude-sonnet-5', 'claude-haiku-4-5']);
  const row = (W) => g.rows.find((r) => r.window === W).usd;
  const sAt = (W) => es.curve.find((c) => c.window === W).usd;
  // Above 200K only the 1M model's cost moves.
  assert.ok(Math.abs((row(400000) - row(300000)) - (sAt(400000) - sAt(300000))) < 1e-6);
  assert.ok(g.rows.some((r) => r.window === 1000000), 'the grid reaches 1M: the 1M model runs at its 967K default there');
  // Plan-usage weights scale a model's vote.
  const w = combineModels([es, eh], { weights: { 'sonnet-5': 0 } });
  assert.equal(w.optimum.window, Math.min(...w.rows.filter((r) => Math.abs(r.usd - w.optimum.usd) < 1e-9).map((r) => r.window)));
});

// =============================================================================
// Money anchor

test('calibrate: picks the write-TTL assumption the cost_usd rows agree with, and anchors on its median', () => {
  const price = (u, ttl) => {
    const inUsd = 2e-6; // sonnet-5
    const w = ttl === '1h' ? 2 : 1.25;
    return u.input_tokens * inUsd + u.cache_creation_tokens * w * inUsd + u.cache_read_tokens * 0.1 * inUsd + u.output_tokens * 5 * inUsd; // $10/MTok out
  };
  const rows = [];
  for (let i = 1; i <= 6; i++) {
    const u = { input_tokens: 1000 * i, output_tokens: 500 * i, cache_read_tokens: 100000 * i, cache_creation_tokens: 30000 + 7000 * i * i };
    rows.push({ resolved_model: 'claude-sonnet-5', ...u, cost_usd: price(u, '1h') });
  }
  rows.push({ resolved_model: 'claude-sonnet-5', input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, cost_usd: 99, auth_error: true });
  rows.push({ resolved_model: 'claude-sonnet-5', input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, cost_usd: 99, is_rescore_retry: true });
  const cal = calibrate({ rows });
  assert.equal(cal.assumption, '1h');
  assert.equal(cal.pooled.n, 6);
  assert.ok(Math.abs(cal.pooled.ratio - 1) < 1e-9);
  // A check of the price table, never an anchor: the basis is list price.
  const a = priceCheckFor('claude-sonnet-5', cal);
  assert.equal(a.basis, 'API list price');
  assert.equal(a.agrees, true);
  assert.match(a.check, /this model, n=6.*agree/);
  assert.match(priceCheckFor('claude-opus-5', cal).check, /pooled/);
  const none = calibrate({ rows: [] });
  assert.equal(priceCheckFor('claude-sonnet-5', none).agrees, null);
  assert.match(priceCheckFor('claude-sonnet-5', none).check, /not checked/);
  const off = priceCheckFor('m', { pooled: { n: 9, ratio: 1.1 }, perModel: {} });
  assert.equal(off.agrees, false);
  assert.match(off.check, /DISAGREES/);
});

test('calibrate: reads results.jsonl under a results root; a missing root is not an error', () => {
  const { dir, cleanup } = makeFixture();
  try {
    assert.equal(calibrate({ resultsRoot: join(dir, 'nope') }).pooled.n, 0);
    const run = join(dir, 'bench', 'run1');
    mkdirSync(run, { recursive: true });
    const row = { resolved_model: 'claude-haiku-4-5', input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 10e-6 + 50e-6 };
    writeFileSync(join(run, 'results.jsonl'), `${JSON.stringify(row)}\nnot json\n`);
    const cal = calibrate({ resultsRoot: join(dir, 'bench') });
    assert.equal(cal.pooled.n, 1);
    assert.ok(Math.abs(cal.pooled.ratio - 1) < 1e-9);
  } finally { cleanup(); }
});

// =============================================================================
// Collection from synthetic transcripts, end to end

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
let n = 0;
const uid = () => `u${++n}`;
const userRec = (ms, o = {}) => ({ type: 'user', uuid: uid(), timestamp: at(ms), message: { role: 'user', content: o.toolResult ? [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] : [{ type: 'text', text: o.text || 'go' }] }, ...(o.isCompactSummary ? { isCompactSummary: true } : {}) });
const asstRec = (ms, rid, { read = 0, write5m = 0, write1h = 0, input = 10, model = 'claude-sonnet-5' } = {}) => ({
  type: 'assistant', uuid: uid(), timestamp: at(ms), requestId: rid,
  message: { id: `m-${rid}`, model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h } } },
});
const boundaryRec = (ms) => ({ type: 'system', subtype: 'compact_boundary', uuid: uid(), timestamp: at(ms), compactMetadata: { trigger: 'auto', preTokens: 30000, postTokens: 2000, durationMs: 1000 } });
const writeJsonl = (p, recs) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); };

function buildCorpus(root) {
  const S = 1000;
  writeJsonl(join(root, 'proj', 'sess1.jsonl'), [
    userRec(0), asstRec(1 * S, 'r1', { write1h: 10000 }),
    userRec(2 * S, { toolResult: true }), asstRec(3 * S, 'r2', { read: 10000, write1h: 20000 }),
    userRec(4 * S, { text: 'next' }), asstRec(5 * S, 'r3', { read: 30000, write1h: 5000 }),
    boundaryRec(6 * S), userRec(7 * S, { isCompactSummary: true }),
    asstRec(8 * S, 'r4', { read: 4000, write1h: 8000 }),
    userRec(9 * S, { toolResult: true }), asstRec(10 * S, 'r5', { read: 12000, write1h: 1000 }),
  ]);
  const sub = join(root, 'proj', 'sess1', 'subagents', 'agent-a1.jsonl');
  writeJsonl(sub, [userRec(20 * S, { text: 'task' }), asstRec(21 * S, 's1', { write5m: 40000 }), userRec(22 * S, { toolResult: true }), asstRec(23 * S, 's2', { read: 40000, write5m: 2000 })]);
  writeFileSync(sub.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'explorer' }));
}

test('collectAdvisorInputs: tracks, growth across a compaction, the compaction record, turns and the spawn baseline', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    buildCorpus(root);
    const inputs = await collectAdvisorInputs({ root, days: 30, now: new Date(T0 + 86400000) });
    const mi = inputs.models.get('claude-sonnet-5');
    assert.equal(mi.requests, 7);
    assert.equal(mi.mainRequests, 5);
    assert.equal(mi.subagentRequests, 2);
    assert.equal(mi.mainTurns, 1, 'the second prompt is a turn; the first request has no gap');
    const main = mi.tracks.find((t) => t.kind === 'main');
    // contexts: 10010, 30010, 35010 | compaction | 12010, 13010
    assert.deepEqual(main.inc, [0, 20000, 5000, 0, 1000]);
    assert.equal(main.start, 10010);
    assert.deepEqual(main.ttl1h, [1, 1, 1, 1, 1]);
    assert.equal(mi.compactions.length, 1);
    assert.equal(mi.compactions[0].firstAfterContext, 12010);
    assert.equal(mi.compactions[0].firstAfterWrite, 8000);
    assert.equal(mi.compactions[0].reworkTokens, null, 'epochs too short to measure rework');
    assert.equal(inputs.spawns.length, 1);
    assert.equal(inputs.spawns[0].agentType, 'explorer');
    const so = spawnOverhead(inputs.spawns, { days: 30 });
    assert.equal(so.rows[0].agentType, 'explorer');
    assert.equal(so.rows[0].contextP50, 40010);
    assert.ok(so.rows[0].usdP50 > 0);
    assert.ok(mi.money.read > 0 && mi.money.write1h > 0 && mi.money.write5m > 0);
  } finally { cleanup(); }
});

test('runCacheAdvisor: a small corpus says insufficient data, reads the configured window, and formats', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    buildCorpus(root);
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ autoCompactWindow: 400000 }));
    const a = await runCacheAdvisor({ root, days: 30, now: new Date(T0 + 86400000), resultsRoot: join(dir, 'none'), env: {}, settingsPath, managedPath: join(dir, 'no-managed.json') });
    assert.equal(a.configured.tokens, 400000);
    assert.equal(a.models[0].status, 'insufficient-data');
    assert.equal(a.global, null);
    assert.equal(a.moneyByModel[0].model, 'claude-sonnet-5');
    const text = formatAdvice(a).join('\n');
    assert.match(text, /insufficient-data/);
    assert.match(text, /no model had enough data/);
    assert.match(text, /nothing was changed/);
    // The summary carries numbers and model ids only.
    const s = summaryOf(a);
    assert.equal(s.configured, 400000);
    assert.equal(s.global, null);
    assert.deepEqual(Object.keys(s.models), ['claude-sonnet-5']);
  } finally { cleanup(); }
});

test('saved summary: round-trips through the state directory; windowHintFor picks the busiest matching model', () => {
  const { stateDir, cleanup } = makeFixture();
  try {
    const dir = join(stateDir, 'state');
    mkdirSync(dir, { recursive: true });
    const advice = {
      generatedAt: '2026-09-25T00:00:00.000Z', windowDays: 30, scan: { truncated: false }, configured: { tokens: 400000 },
      global: { optimum: { window: 250000 }, band5: [200000, 300000] },
      models: [
        { model: 'claude-opus-5', status: 'ok', optimum: { window: 225000 }, band5: [225000, 275000], requests: 900 },
        { model: 'claude-opus-5-5', status: 'ok', optimum: { window: 250000 }, band5: [225000, 300000], requests: 100 },
        { model: 'claude-fable-5', status: 'insufficient-data', requests: 50 },
      ],
    };
    saveAdvisorSummary(advice, dir);
    const s = loadAdvisorSummary(dir);
    assert.equal(s.global.window, 250000);
    const h = windowHintFor(s, 'opus');
    assert.equal(h.model, 'claude-opus-5');
    assert.equal(h.window, 225000);
    const o55 = windowHintFor(s, 'opus', { modelId: 'claude-opus-5-5' });
    assert.equal(o55.model, 'claude-opus-5-5', 'the id the alias resolves to wins over the busier opus-5');
    assert.equal(o55.window, 250000);
    assert.equal(o55.generatedAt, '2026-09-25T00:00:00.000Z');
    assert.equal(o55.truncated, false);
    assert.equal(h.global, 250000);
    assert.equal(h.configured, 400000);
    const f = windowHintFor(s, 'fable');
    assert.equal(f.window, null, 'no per-model window without enough data');
    assert.equal(f.global, 250000);
    assert.equal(windowHintFor(null, 'opus'), null);
    assert.equal(loadAdvisorSummary(join(dir, 'missing')), null);
  } finally { cleanup(); }
});

// =============================================================================
// Entry points: the CLI, the audit check, /ac recommend

const run = (rel, args, env) => spawnSync(process.execPath, [join(PLUGIN_ROOT, rel), ...args], {
  windowsHide: true, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000,
});

test('CLI: --json on a synthetic root; --no-save writes nothing; a normal run saves the summary', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    buildCorpus(root);
    const r = run('scripts/cache-advisor.mjs', ['--json', '--days', '3650', '--root', root, '--no-save'], {});
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout);
    assert.equal(a.models[0].model, 'claude-sonnet-5');
    assert.equal(existsSync(join(stateDir, 'state', 'cache-advisor.json')), false);
    const h = run('scripts/cache-advisor.mjs', ['--days', '3650', '--root', root], {});
    assert.equal(h.status, 0, h.stderr);
    assert.match(h.stdout, /cache-advisor — last 3650d/);
    assert.equal(existsSync(join(stateDir, 'state', 'cache-advisor.json')), true);
  } finally { cleanup(); }
});

test('audit --only cache-advisor: skips with nothing to replay, never errors, saves the summary', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const r = run('scripts/audit.mjs', ['--only', 'cache-advisor', '--json'], { AGENT_COMPANION_TRANSCRIPTS_ROOT: join(dir, 'empty') });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.results[0].id, 'cache-advisor');
    assert.equal(out.results[0].status, 'skip');
    assert.equal(existsSync(join(stateDir, 'state', 'cache-advisor.json')), true);
  } finally { cleanup(); }
});

test('/ac recommend quotes a saved advisor summary, and prints nothing about it without one', () => {
  const { stateDir, cleanup } = makeFixture();
  try {
    const before = run('scripts/recommend.mjs', ['--type', 'explore'], {});
    assert.equal(before.status, 0, before.stderr);
    assert.doesNotMatch(before.stdout, /auto-compact:/);
    const dir = join(stateDir, 'state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cache-advisor.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), windowDays: 30, configured: null, global: { window: 250000, band5: [200000, 300000] },
      models: { 'claude-opus-5-5': { status: 'ok', window: 250000, band5: [225000, 300000], requests: 10 }, 'claude-sonnet-5': { status: 'ok', window: 225000, band5: [225000, 250000], requests: 10 } },
    }));
    const after = run('scripts/recommend.mjs', ['--type', 'explore'], {});
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /auto-compact: .*250K.*yours: unset/);
    assert.match(after.stdout, /advice from cache-advisor on \d{4}-\d{2}-\d{2} \(full 30d read\)/, 'the date is always shown');
    const json = JSON.parse(run('scripts/recommend.mjs', ['--type', 'explore', '--json'], {}).stdout);
    assert.equal(json.autoCompact.global, 250000);
  } finally { cleanup(); }
});

test('config/compaction.json: every priced model has a window spec, and the grid spans the documented 100K-1M', () => {
  const cfg = compactionConfig();
  assert.equal(cfg.window.min, 100000);
  assert.equal(cfg.window.max, 1000000);
  const pricing = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-pricing.json'), 'utf8'));
  for (const alias of Object.keys(pricing.models)) {
    assert.ok(cfg.models[alias], `config/compaction.json has no entry for priced model ${alias}`);
    assert.ok(priceSpecFor(`claude-${alias}`), alias);
  }
});

// =============================================================================
// Fix round: real traffic only, rework off, the per-model floor, partial reads

test('isBenchProject: the harness temp dirs are excluded; ordinary projects are not', () => {
  const tmp = 'C:\\Users\\you\\AppData\\Local\\Temp';
  assert.equal(isBenchProject('C--Users-you-AppData-Local-Temp-bench-sonnet-medium-task-AbC123', { tmp }), true);
  assert.equal(isBenchProject('C--Users-you-AppData-Local-Temp-bench-judge-x1', { tmp }), true);
  assert.equal(isBenchProject('C--Users-you-AppData-Local-Temp-rescore-task-x1', { tmp }), true);
  assert.equal(isBenchProject('-var-folders-ab-cd-T-bench-haiku-t-x', { tmp: '/var/folders/ab/cd/T' }), true, "macOS temp, this machine's own prefix");
  assert.equal(isBenchProject('-tmp-bench-haiku-t-x', { tmp: '/somewhere/else' }), true, 'a corpus copied from a Linux machine');
  assert.equal(isBenchProject('C--Users-you-dev-bench-tools', { tmp }), false, 'a real project called bench is real traffic');
  assert.equal(isBenchProject('C--Users-you-dev-proj', { tmp }), false);
});

test('isBenchProject: the prefixes it relies on are still the ones the benchmark harness creates', () => {
  const src = (f) => readFileSync(join(PLUGIN_ROOT, 'bench', f), 'utf8');
  assert.match(src('runner.mjs'), /mkdtempSync\(path\.join\(os\.tmpdir\(\), "bench-" \+ cellId/);
  assert.match(src('judge.mjs'), /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'bench-judge-'\)\)/);
  assert.match(src('rescore.mjs'), /mkdtempSync\(path\.join\(os\.tmpdir\(\), "rescore-" \+ taskId/);
  assert.deepEqual(BENCH_DIR_PREFIXES, ['bench-', 'rescore-']);
});

test('collectAdvisorInputs: bench projects are counted as excluded; includeBench reads them', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    buildCorpus(root);
    const S = 1000;
    writeJsonl(join(root, 'C--Users-you-AppData-Local-Temp-bench-sonnet-low-t-Xy1', 'b1.jsonl'), [userRec(0), asstRec(1 * S, 'b1', { write5m: 1000 }), userRec(2 * S, { toolResult: true }), asstRec(3 * S, 'b2', { read: 1000, write5m: 10 })]);
    const now = new Date(T0 + 86400000);
    const real = await collectAdvisorInputs({ root, days: 30, now });
    assert.equal(real.excludedBenchProjects, 1);
    assert.equal(real.models.get('claude-sonnet-5').requests, 7, 'the bench session is not pooled');
    const all = await collectAdvisorInputs({ root, days: 30, now, includeBench: true });
    assert.equal(all.models.get('claude-sonnet-5').requests, 9);
    assert.equal(all.excludedBenchProjects, 0);
  } finally { cleanup(); }
});

const reworkComps = [30000, 30000, 30000].map((r) => comp('main', { reworkTokens: r }));

test('evaluateModel: the rework-off view is the whole evaluation with rework 0, over its own allowed windows', () => {
  const mi = modelInput('claude-sonnet-5', longTracks(6), { compactions: reworkComps, mainTurns: 240 });
  const all = new Map([[mi.model, mi]]);
  const e = evaluateModel(mi, all);
  assert.equal(e.params.byKind.main.rework, 30000);
  const direct = evaluateModel(mi, all, { reworkFixed: 0 });
  assert.equal(direct.params.reworkUsed, 0);
  assert.equal(e.noRework.window, direct.optimum.window);
  assert.deepEqual(e.noRework.band5, direct.band5);
  assert.equal(e.noReworkOptimum, direct.optimum.window);
  assert.ok(e.noRework.window <= e.optimum.window, 'rework makes a compaction dearer, so it never lowers the optimum');
  assert.equal(direct.noRework, null, 'no nested sensitivity inside the sensitivity');
  // The closed form is a compaction point; the setting is 33K above it.
  assert.equal(e.closedFormWindow, e.closedFormThreshold + 33000);
});

test('combineModels: a model that compacts more often than the floor at the mix optimum is listed, not hidden', () => {
  // Same traffic; model B does 200 requests per turn, so at any window where it
  // compacts, it compacts every turn or so. The mix floor (at 1 request/turn)
  // allows small windows.
  const a = modelInput('claude-sonnet-5', longTracks(6), { compactions: threeComps, mainTurns: 2400 });
  const b = modelInput('claude-fable-5-1', longTracks(6), { compactions: threeComps, mainTurns: 12 });
  const all = new Map([[a.model, a], [b.model, b]]);
  const ea = evaluateModel(a, all);
  const eb = evaluateModel(b, all);
  const g = combineModels([ea, eb], { requestsPerTurn: 1, minTurnsPerCompaction: 10 });
  const t = g.optimum.perModelTurnsPerCompaction;
  assert.ok(t['claude-fable-5-1'] != null && t['claude-fable-5-1'] < 10, `fable turns ${t['claude-fable-5-1']}`);
  assert.deepEqual(g.optimum.belowFloor.map((x) => x.model), Object.entries(t).filter(([, v]) => v != null && v < 10).map(([m]) => m));
  assert.ok(g.optimum.belowFloor.some((x) => x.model === 'claude-fable-5-1'));
  const fb = g.optimum.belowFloor.find((x) => x.model === 'claude-fable-5-1');
  assert.equal(fb.atCap, g.optimum.window >= 1000000, 'at its cap only when the setting reaches its context window');
});

function adviceFixture({ truncated = false, configured } = {}) {
  const s = modelInput('claude-sonnet-5', longTracks(6), { compactions: reworkComps, mainTurns: 240 });
  const models = new Map([[s.model, s]]);
  const nowMs = T0 + 30 * 86400000;
  const inputs = {
    models, spawns: [], windowDays: 30, nowMs, sinceMs: T0, excludedBenchProjects: 2,
    scan: { filesFound: 10, filesRead: truncated ? 4 : 10, filesSkipped: truncated ? 6 : 0, truncated, wallMs: 1000, exists: true },
    oldestReadMtimeMs: truncated ? nowMs - 3 * 86400000 : T0,
  };
  return adviseFromInputs(inputs, { configured: configured || { tokens: null, source: 'unset', ignored: [], notes: [] } });
}

test('formatAdvice: the value to type in both forms, list price, the rework-off line, and an ignored setting said loudly', () => {
  const ignored = { tokens: null, source: 'unset', ignored: [{ source: 'user settings autoCompactWindow', raw: '400k', reason: 'it must be an integer from 100000 to 1000000' }], notes: [] };
  const a = adviceFixture({ configured: ignored });
  const W = a.global.optimum.window;
  assert.deepEqual(a.global.toType, { settingsValue: W, command: `/autocompact ${W / 1000}k` });
  assert.equal(a.moneyBasis, 'API list price');
  assert.equal(a.models[0].moneyBasis, 'API list price');
  const text = formatAdvice(a).join('\n');
  assert.ok(text.includes(`TO APPLY, type one of: /autocompact ${W / 1000}k`));
  assert.ok(text.includes(`"autoCompactWindow": ${W}`));
  assert.match(text, /compacts at about \d+K on 1M models/);
  assert.match(text, /API list price/);
  assert.doesNotMatch(text, /anchored/);
  assert.match(text, /WARNING: your user settings autoCompactWindow "400k" is IGNORED by Claude Code/);
  assert.match(text, /rework off: cheapest \d+K/);
  assert.match(text, /2 benchmark project dir\(s\) excluded/);
  assert.match(text, /more than the cheapest over 30d/);
  assert.doesNotMatch(text, /PARTIAL/);
});

test('a partial read says so, does not claim 30 days, and never replaces a saved full-read summary', () => {
  const { stateDir, cleanup } = makeFixture();
  try {
    const dir = join(stateDir, 'state');
    mkdirSync(dir, { recursive: true });
    const part = adviceFixture({ truncated: true });
    assert.equal(part.coverage.truncated, true);
    assert.ok(Math.abs(part.coverage.completeDays - 3) < 1e-9);
    const text = formatAdvice(part).join('\n');
    assert.match(text, /PARTIAL READ: the time budget stopped after 4 of 10 files, newest first/);
    assert.doesNotMatch(text, /over 30d/);
    assert.match(text, /PARTIAL: 4 of 10 files, complete only for the newest 3\.0d/);
    // No saved summary yet: the partial one is written, flagged.
    assert.ok(saveAdvisorSummary(part, dir));
    assert.equal(loadAdvisorSummary(dir).truncated, true);
    // A full read replaces it; a later partial read does not replace the full one.
    const full = adviceFixture();
    assert.ok(saveAdvisorSummary(full, dir));
    assert.equal(saveAdvisorSummary(part, dir), null);
    const kept = loadAdvisorSummary(dir);
    assert.equal(kept.truncated, false);
    assert.equal(kept.filesRead, 10);
    assert.equal(windowHintFor(kept, 'sonnet').truncated, false);
    assert.deepEqual(coverageOf({ scan: { truncated: false }, windowDays: 30 }).completeDays, 30);
  } finally { cleanup(); }
});

test('/ac recommend marks a partial summary as partial', () => {
  const { stateDir, cleanup } = makeFixture();
  try {
    const dir = join(stateDir, 'state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cache-advisor.json'), JSON.stringify({
      generatedAt: '2026-09-26T00:00:00.000Z', windowDays: 30, truncated: true, filesRead: 505, filesFound: 2742, configured: 400000,
      global: { window: 275000, band5: [250000, 350000] }, models: {},
    }));
    const r = run('scripts/recommend.mjs', ['--type', 'explore'], {});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /auto-compact: .*275K \(\/autocompact 275k\).*yours: 400K — advice from cache-advisor on 2026-09-26 \(PARTIAL read, 505 of 2742 files\)/);
  } finally { cleanup(); }
});
