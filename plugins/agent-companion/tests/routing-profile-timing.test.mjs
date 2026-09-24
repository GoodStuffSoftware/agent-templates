// ADR 0003 slice 2 acceptance: "The hook adds under 5 ms" with a realistic
// profile. Measured in fresh child processes, the way a hook runs: the cost
// of loading the profile module plus the spawn guard's resolver calls with
// the profile read COLD, compared with the same calls when no profile file
// exists. Medians over several runs, so one slow scheduler tick does not
// decide it. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, TESTS_DIR, runHook } from './helpers.mjs';

const BUDGET_MS = 5;
const RUNS = 9;
const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');

// A realistic profile: a row for every shipped type, three local types each
// with a row, benchmark provenance blocks, notes — larger than any profile a
// person writes by hand.
function realisticProfile() {
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
  for (const [n, w] of [['git-plumbing', 2], ['research', 3], ['writing-docs', 2]]) {
    types[n] = { weight: w, kind: 'bounded', consequence: 'routine', summary: n, origin: 'cluster', createdAt: '2026-09-23' };
    rows[n] = { state: 'trial', model: 'sonnet', effort: 'high', cacheTtl: null, source: 'grid-derived', since: '2026-09-23', reviewBy: '2026-10-07', waivesFloor: null, note: null, provenance: null };
  }
  return {
    schema: 'agent-companion/routing-profile', schemaVersion: 1, revision: 42,
    basedOn: { tableVersion: 7, tableUpdated: '2026-09-23' }, objective: 'api-cost', planUsageMultipliers: null, types, rows,
  };
}

function measure(stateDir, type) {
  const res = spawnSync(process.execPath, [join(TESTS_DIR, 'fixtures', 'routing-profile', 'hook-cost.mjs'), type], {
    encoding: 'utf8', env: { ...process.env, AGENT_COMPANION_STATE_DIR: stateDir }, windowsHide: true, timeout: 20000,
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim());
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

test(`routing profiles add under ${BUDGET_MS} ms to a hook invocation (realistic profile, cold read, fresh process)`, (t) => {
  const withDir = join(fx.dir, 'with');
  const withoutDir = join(fx.dir, 'without');
  mkdirSync(join(withDir, 'config'), { recursive: true });
  mkdirSync(join(withoutDir, 'config'), { recursive: true });
  const p = realisticProfile();
  writeFileSync(join(withDir, 'config', 'routing-profile.json'), JSON.stringify(p, null, 2));
  const withRuns = [];
  const withoutRuns = [];
  for (let i = 0; i < RUNS; i += 1) {
    withRuns.push(measure(withDir, 'bounded-feature'));
    withoutRuns.push(measure(withoutDir, 'bounded-feature'));
  }
  assert.ok(withRuns.every((r) => r.layer === 'profile' && r.names === Object.keys(ctx.modelTiers().taskTypes).length + 3), 'the profile row actually won');
  assert.ok(withoutRuns.every((r) => r.layer === 'trial'));
  const importMs = median(withRuns.map((r) => r.importMs));
  const withMs = median(withRuns.map((r) => r.resolveMs));
  const withoutMs = median(withoutRuns.map((r) => r.resolveMs));
  const added = importMs + Math.max(0, withMs - withoutMs);
  t.diagnostic(`profile module load ${importMs.toFixed(2)} ms; resolver calls with profile ${withMs.toFixed(2)} ms vs none ${withoutMs.toFixed(2)} ms; added ${added.toFixed(2)} ms (budget ${BUDGET_MS} ms; ${Object.keys(p.rows).length} rows, ${JSON.stringify(p).length} bytes)`);
  assert.ok(added < BUDGET_MS, `routing profile adds ${added.toFixed(2)} ms per hook invocation (budget ${BUDGET_MS} ms)`);
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
