// ADR 0003 slice 2 acceptance: "The hook adds under 5 ms" with a realistic
// profile. Measured in fresh child processes, the way a hook runs, against
// the resolver as it stood BEFORE routing profiles (a vendored baseline):
// the whole added cost, module loading included, not only the profile read
// (S2 review P9: the old measure left the baseline's own growth out). Lower
// quartiles of interleaved runs, so neither one slow scheduler tick nor the
// parallel test run's load decides it. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, TESTS_DIR, PLUGIN_ROOT, runHook } from './helpers.mjs';
import { sha256Text } from './fixtures/route-golden/live-gate.mjs';

const BUDGET_MS = 5;
// The baseline path's cost on a quiet machine (lower quartile, 2026-09-24).
const REFERENCE_BASELINE_MS = 10.7;
const RUNS = 15;
const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');

// A realistic profile: a row for every shipped type, three local types each
// with a row, benchmark provenance blocks, notes — larger than any profile a
// person writes by hand.
function realisticProfile(minRows = 0) {
  const types = {};
  const rows = {};
  const prov = (i) => ({
    runs: [`run-${i}-a`, `run-${i}-b`], measuredAt: '2026-09-23', n: 12, packs: 4,
    pass: { k: 12, n: 12, ci95: [0.76, 1.0] }, judge: { n: 12, passRate: 0.92, calibrated: true },
    costIndex: 0.9, planUsageIndex: null, benchmarkTier: 'user-mined',
    resolvedModelIds: { opus: 'claude-opus-5-5' }, cliVersion: '2.1.300', aliasFloor: '2.1.280', typeDefSha: 'a'.repeat(64),
  });
  let i = 0;
  for (const [name, t] of Object.entries(ctx.modelTiers().taskTypes)) {
    i += 1;
    if (t.weight === 'parity') rows[name] = { state: 'adopted', model: null, effort: 'high', cacheTtl: null, source: 'operator-observed', since: '2026-09-01', reviewBy: null, waivesFloor: null, note: 'review floor', provenance: null };
    else if (t.consequence === 'critical') rows[name] = { state: 'trial', model: 'opus', effort: 'xhigh', cacheTtl: '5m', source: 'benchmark', since: '2026-09-23', reviewBy: '2026-10-07', waivesFloor: null, note: 'measured', provenance: prov(i) };
    else rows[name] = { state: i % 3 ? 'trial' : 'adopted', model: 'opus', effort: 'high', cacheTtl: null, source: 'benchmark', since: '2026-09-23', reviewBy: '2026-10-07', waivesFloor: null, note: `row ${i}`, provenance: prov(i) };
  }
  const locals = [['git-plumbing', 2], ['research', 3], ['writing-docs', 2]];
  while (Object.keys(rows).length + locals.length < minRows) locals.push([`local-type-${locals.length}`, 1 + (locals.length % 5)]);
  for (const [n, w] of locals) {
    types[n] = { weight: w, kind: 'bounded', consequence: 'routine', summary: n, origin: 'cluster', createdAt: '2026-09-23' };
    rows[n] = { state: 'trial', model: 'sonnet', effort: 'high', cacheTtl: null, source: 'grid-derived', since: '2026-09-23', reviewBy: '2026-10-07', waivesFloor: null, note: null, provenance: null };
  }
  return {
    schema: 'agent-companion/routing-profile', schemaVersion: 1, revision: 42,
    basedOn: { tableVersion: 7, tableUpdated: '2026-09-23' }, objective: 'api-cost', planUsageMultipliers: null, types, rows,
  };
}

// A plugin tree staged in a temp dir: `contextSource` as hooks/lib/context.mjs
// plus every sibling module it imports from the real hooks/lib, the CURRENT
// config and plugin manifest. Both sides of the comparison are staged the
// same way, so neither gets a path or cache advantage.
function stageTree(tag, contextSource) {
  const dir = join(fx.dir, `stage-${tag}`);
  mkdirSync(join(dir, 'hooks', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'lib', 'context.mjs'), contextSource);
  for (const [, rel] of contextSource.matchAll(/from\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) {
    copyFileSync(join(PLUGIN_ROOT, 'hooks', 'lib', rel), join(dir, 'hooks', 'lib', rel));
  }
  copyFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), join(dir, 'config', 'model-tiers.json'));
  copyFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), join(dir, '.claude-plugin', 'plugin.json'));
  return dir;
}

function measure(root, stateDir, type) {
  const res = spawnSync(process.execPath, [join(TESTS_DIR, 'fixtures', 'routing-profile', 'hook-cost.mjs'), root, type], {
    encoding: 'utf8', env: { ...process.env, AGENT_COMPANION_STATE_DIR: stateDir, AGENT_COMPANION_HOME_OVERRIDE: stateDir }, windowsHide: true, timeout: 20000,
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim());
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
// The lower quartile: a hook's cost on a quiet machine. `node --test` runs
// test files in parallel, and under that load every fresh process slows unevenly;
// the median then measures the scheduler as much as the code, while the
// lower quartile of interleaved runs still reflects the code.
const lowQ = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 4)]; };

// The baseline is the resolver as it stood before routing profiles:
// hooks/lib/context.mjs at the last commit before slice 2, vendored byte for
// byte and pinned here.
const BASELINE = join(TESTS_DIR, 'fixtures', 'routing-profile', 'baseline', 'context.mjs');
const BASELINE_SHA256 = '4f1c9c26288ac76248d4b6b062589f2f78886142c9574f7b91b2ab107b512de3';

test('the timing baseline is the pre-slice-2 resolver, byte for byte', () => {
  assert.equal(sha256Text(BASELINE), BASELINE_SHA256, 'fixtures/routing-profile/baseline/context.mjs must never be edited');
});

test(`routing profiles add under ${BUDGET_MS} ms to the spawn guard's routing path, measured against the pre-profile baseline (module loading included, 50-row profile, cold, fresh process)`, (t) => {
  const baseRoot = stageTree('baseline', readFileSync(BASELINE, 'utf8'));
  const curRoot = stageTree('current', readFileSync(join(PLUGIN_ROOT, 'hooks', 'lib', 'context.mjs'), 'utf8'));
  const withDir = join(fx.dir, 'with');
  const withoutDir = join(fx.dir, 'without');
  mkdirSync(join(withDir, 'config'), { recursive: true });
  mkdirSync(join(withoutDir, 'config'), { recursive: true });
  const p = realisticProfile(50);
  writeFileSync(join(withDir, 'config', 'routing-profile.json'), JSON.stringify(p, null, 2));
  const base = []; const none = []; const withP = [];
  for (let i = 0; i < RUNS; i += 1) {
    base.push(measure(baseRoot, withoutDir, 'bounded-feature'));
    none.push(measure(curRoot, withoutDir, 'bounded-feature'));
    withP.push(measure(curRoot, withDir, 'bounded-feature'));
  }
  assert.ok(withP.every((r) => r.layer === 'profile'), 'the profile row actually won');
  assert.ok(none.every((r) => r.layer === 'trial') && base.every((r) => r.layer === 'trial'));
  const b = lowQ(base.map((r) => r.totalMs));
  const n = lowQ(none.map((r) => r.totalMs));
  const w = lowQ(withP.map((r) => r.totalMs));
  t.diagnostic(`lower quartile of ${RUNS} interleaved runs: baseline ${b.toFixed(2)} ms; current, no profile ${n.toFixed(2)} ms (+${(n - b).toFixed(2)}); current, ${Object.keys(p.rows).length}-row profile ${w.toFixed(2)} ms (+${(w - b).toFixed(2)}); budget ${BUDGET_MS} ms; ${JSON.stringify(p).length} bytes`);
  // Under the parallel test run's load every process slows roughly in
  // proportion, so the budget is asserted as a SHARE of the baseline path:
  // 5 ms against the baseline's cost on a quiet machine (REFERENCE_BASELINE_MS,
  // measured 2026-09-24). On a quiet run (baseline near that reference) the
  // absolute 5 ms is asserted too.
  const share = BUDGET_MS / REFERENCE_BASELINE_MS;
  for (const [label, added] of [['with a profile', w - b], ['with no profile', n - b]]) {
    assert.ok(added / b < share, `routing profiles add ${added.toFixed(2)} ms ${label}: ${(100 * added / b).toFixed(0)}% of the ${b.toFixed(2)} ms baseline path (budget ${(100 * share).toFixed(0)}%, i.e. ${BUDGET_MS} ms of ${REFERENCE_BASELINE_MS} ms)`);
    if (b <= REFERENCE_BASELINE_MS * 1.15) assert.ok(added < BUDGET_MS, `routing profiles add ${added.toFixed(2)} ms ${label} on a quiet run (budget ${BUDGET_MS} ms)`);
  }
});

test('in-process: a warm (mtime-cached) resolve with a realistic profile stays well under the budget', () => {
  mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
  writeFileSync(join(fx.stateDir, 'config', 'routing-profile.json'), JSON.stringify(realisticProfile()));
  ctx.resolveRoute({ type: 'bounded-feature' }); // cold
  const N = 200;
  const t0 = performance.now();
  for (let i = 0; i < N; i += 1) ctx.resolveRoute({ type: 'integration' });
  const per = (performance.now() - t0) / N;
  assert.ok(per < 1, `warm resolveRoute ${per.toFixed(3)} ms`);
});

test('end to end: the spawn-guard hook with and without a realistic profile (reported, not asserted: process noise)', (t) => {
  const withDir = join(fx.dir, 'e2e-with');
  const withoutDir = join(fx.dir, 'e2e-without');
  for (const d of [withDir, withoutDir]) mkdirSync(join(d, 'config'), { recursive: true });
  writeFileSync(join(withDir, 'config', 'routing-profile.json'), JSON.stringify(realisticProfile()));
  const run = (stateDir, i) => {
    const t0 = performance.now();
    runHook('hooks/spawn-guard.mjs', {
      session_id: `test-e2e-${i}`, agent_type: 'main', cwd: fx.dir,
      tool_input: { subagent_type: 'general-purpose', model: 'opus', run_in_background: true, name: 'w', prompt: 'TYPE: bounded-feature\ngo' },
    }, { env: { AGENT_COMPANION_STATE_DIR: stateDir, CLAUDE_PLUGIN_DATA: join(fx.dir, 'data') } });
    return performance.now() - t0;
  };
  const a = []; const b = [];
  for (let i = 0; i < 5; i += 1) { a.push(run(withDir, i)); b.push(run(withoutDir, i)); }
  t.diagnostic(`spawn-guard wall time median: with profile ${median(a).toFixed(1)} ms, without ${median(b).toFixed(1)} ms`);
});
