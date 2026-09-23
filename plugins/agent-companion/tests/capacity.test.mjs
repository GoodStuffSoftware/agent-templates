// Tests for scripts/capacity.mjs and hooks/capacity-probe.mjs.
//
// All the decision logic (computeHeadroomGB / computeConcurrencyBudget /
// computePolicy / computeBudget) is pure math tested with synthetic numbers
// -- never os.totalmem()/os.freemem(), which would make results depend on
// whatever machine happens to run the suite. The one place that touches the
// real machine (buildReport's default call, and the hook) is exercised only
// to confirm it does not throw and returns the right SHAPE, never asserted
// against specific values.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, runScript, assertNotRealHome } from './helpers.mjs';
import {
  computeHeadroomGB,
  computeConcurrencyBudget,
  computePolicy,
  computeBudget,
  buildReport,
  formatText,
  formatHookLine,
} from '../scripts/capacity.mjs';

const PLUGIN = 'agent-companion';

function writeSettings(dir, obj, { file = 'settings.json' } = {}) {
  const claudeDirPath = join(dir, '.claude');
  assertNotRealHome(claudeDirPath, 'claudeDir()');
  mkdirSync(claudeDirPath, { recursive: true });
  const path = join(claudeDirPath, file);
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}

function withOptions(options, key = `${PLUGIN}@agent-templates`) {
  return { pluginConfigs: { [key]: { options } } };
}

// ---------------------------------------------------------------------------
// computeHeadroomGB
// ---------------------------------------------------------------------------

test('computeHeadroomGB: 25% of total when that exceeds the 4GB floor', () => {
  assert.equal(computeHeadroomGB(64), 16);
  assert.equal(computeHeadroomGB(32), 8);
});

test('computeHeadroomGB: floors at 4GB on small machines', () => {
  assert.equal(computeHeadroomGB(8), 4); // 25% of 8 = 2, floored to 4
  assert.equal(computeHeadroomGB(4), 4);
  assert.equal(computeHeadroomGB(0), 4);
});

// ---------------------------------------------------------------------------
// computeConcurrencyBudget
// ---------------------------------------------------------------------------

test('computeConcurrencyBudget: straightforward division, floored', () => {
  // 40GB free, 16GB headroom => 24GB usable / 0.3GB per agent = 80
  assert.equal(computeConcurrencyBudget(40, 16, 0.3), 80);
});

test('computeConcurrencyBudget: clamps to >= 1 when usable memory is negative or tiny', () => {
  assert.equal(computeConcurrencyBudget(10, 16, 0.3), 1); // usable is negative
  assert.equal(computeConcurrencyBudget(16, 16, 0.3), 1); // usable is exactly zero
  assert.equal(computeConcurrencyBudget(16.1, 16, 5), 1); // usable positive but < one agent's worth
});

test('computeConcurrencyBudget: clamps to >= 1 even with a huge per-agent estimate', () => {
  assert.equal(computeConcurrencyBudget(100, 16, 1000), 1);
});

// ---------------------------------------------------------------------------
// computePolicy
// ---------------------------------------------------------------------------

test('computePolicy: idle-teammates-ok at and above threshold', () => {
  assert.equal(computePolicy(12, 12).policy, 'idle-teammates-ok');
  assert.equal(computePolicy(50, 12).policy, 'idle-teammates-ok');
});

test('computePolicy: stop-between-rounds below threshold', () => {
  assert.equal(computePolicy(11, 12).policy, 'stop-between-rounds');
  assert.equal(computePolicy(1, 12).policy, 'stop-between-rounds');
});

test('computePolicy: reason names the numbers on both sides', () => {
  const r = computePolicy(3, 12);
  assert.match(r.reason, /3/);
  assert.match(r.reason, /12/);
});

// ---------------------------------------------------------------------------
// computeBudget (full pure computation)
// ---------------------------------------------------------------------------

test('computeBudget: end-to-end on a generous machine', () => {
  const r = computeBudget({ totalGB: 64, freeGB: 41, perAgentMB: 300, concurrencyThreshold: 12 });
  assert.equal(r.totalGB, 64);
  assert.equal(r.freeGB, 41);
  assert.equal(r.headroomGB, 16); // 25% of 64
  // usable = 41 - 16 = 25GB; perAgentGB = 300/1024 ~= 0.29297
  assert.equal(r.concurrencyBudget, Math.floor(25 / (300 / 1024)));
  assert.equal(r.policy, 'idle-teammates-ok');
});

test('computeBudget: end-to-end on a tight machine (small/full box)', () => {
  const r = computeBudget({ totalGB: 8, freeGB: 1.5, perAgentMB: 300, concurrencyThreshold: 12 });
  assert.equal(r.headroomGB, 4); // floor, not 25% of 8
  assert.equal(r.concurrencyBudget, 1); // usable is negative -> clamped
  assert.equal(r.policy, 'stop-between-rounds');
});

test('computeBudget: explicit headroomGB overrides the computed one', () => {
  const r = computeBudget({ totalGB: 64, freeGB: 41, headroomGB: 2, perAgentMB: 300 });
  assert.equal(r.headroomGB, 2);
});

test('computeBudget: carries cpuCount / availableParallelism / liveAgentProcesses through untouched', () => {
  const r = computeBudget({
    totalGB: 16, freeGB: 8, cpuCount: 8, availableParallelism: 8, liveAgentProcesses: 3,
  });
  assert.equal(r.cpus, 8);
  assert.equal(r.availableParallelism, 8);
  assert.equal(r.liveAgentProcesses, 3);
});

test('computeBudget: liveAgentProcesses defaults to null (probe skipped or failed)', () => {
  const r = computeBudget({ totalGB: 16, freeGB: 8 });
  assert.equal(r.liveAgentProcesses, null);
});

// ---------------------------------------------------------------------------
// formatText / formatHookLine
// ---------------------------------------------------------------------------

test('formatText: renders GB, cpu count, agent count and policy', () => {
  const r = computeBudget({ totalGB: 32, freeGB: 20, cpuCount: 8, perAgentMB: 300, concurrencyThreshold: 12 });
  r.liveAgentProcesses = 4;
  const text = formatText(r);
  assert.match(text, /32 GB total/);
  assert.match(text, /20 GB free/);
  assert.match(text, /8 cpus/);
  assert.match(text, /4 live agent process/);
  assert.match(text, new RegExp(`budget ${r.concurrencyBudget} concurrent agents`));
  assert.match(text, /idle-teammates-ok/);
});

test('formatText: renders "unknown" when the process count is null', () => {
  const r = computeBudget({ totalGB: 32, freeGB: 20 });
  const text = formatText(r);
  assert.match(text, /unknown live agent process/);
});

test('formatHookLine: short, prefixed, and matches the plugin’s existing SessionStart line style', () => {
  const r = computeBudget({ totalGB: 64, freeGB: 41, concurrencyThreshold: 12 });
  const line = formatHookLine(r);
  assert.match(line, /^\[agent-companion\] capacity: /);
  assert.match(line, /64 GB total/);
  assert.match(line, /41 GB free/);
  assert.match(line, new RegExp(`budget ${r.concurrencyBudget} concurrent agents`));
  assert.match(line, /idle teammates OK/);
  assert.ok(line.length < 200, `hook line should stay compact, got ${line.length} chars: ${line}`);
});

test('formatHookLine: names "stop teammates between rounds" under threshold', () => {
  const r = computeBudget({ totalGB: 8, freeGB: 1, concurrencyThreshold: 12 });
  const line = formatHookLine(r);
  assert.match(line, /stop teammates between rounds/);
});

// ---------------------------------------------------------------------------
// buildReport: option overrides (settings.json / CLAUDE_PLUGIN_OPTION_*)
// ---------------------------------------------------------------------------

test('buildReport: explicit args win over options and defaults', () => {
  const { cleanup } = makeFixture();
  try {
    const r = buildReport({
      perAgentMB: 500,
      headroomGB: 3,
      concurrencyThreshold: 7,
      includeProcessCount: false,
    });
    assert.equal(r.perAgentMB, 500);
    assert.equal(r.headroomGB, 3);
    assert.equal(r.liveAgentProcesses, null);
    // policy/threshold reflect 7, not the default 12 -- assert via the reason string
    assert.match(r.reason, /threshold 7/);
  } finally {
    cleanup();
  }
});

test('buildReport: reads capacity_* options from settings.json when no explicit arg or env var is set', () => {
  const { dir, cleanup } = makeFixture();
  const savedEnv = {};
  for (const k of Object.keys(process.env)) {
    if (k.toUpperCase().startsWith('CLAUDE_PLUGIN_OPTION_')) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  }
  try {
    writeSettings(dir, withOptions({
      capacity_per_agent_mb: 750,
      capacity_concurrency_threshold: 3,
    }));
    const r = buildReport({ includeProcessCount: false });
    assert.equal(r.perAgentMB, 750);
    assert.match(r.reason, /threshold 3/);
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
    cleanup();
  }
});

test('buildReport: never throws and always returns the full shape (real-machine call)', () => {
  const r = buildReport({ includeProcessCount: false });
  for (const key of ['totalGB', 'freeGB', 'cpus', 'headroomGB', 'concurrencyBudget', 'policy', 'reason']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, key), `missing key ${key}`);
  }
  assert.ok(['idle-teammates-ok', 'stop-between-rounds'].includes(r.policy));
  assert.ok(r.concurrencyBudget >= 1);
});

// ---------------------------------------------------------------------------
// CLI (--text / JSON / flags), via the shared runScript helper
// ---------------------------------------------------------------------------

test('CLI: default JSON output on real machine, always valid and shaped', () => {
  const res = runScript('scripts/capacity.mjs', ['--no-process-count']);
  assert.equal(res.status, 0, `stderr=${res.stderr}`);
  assert.ok(res.json, `expected JSON stdout, got: ${res.stdout}`);
  assert.equal(res.json.liveAgentProcesses, null);
  assert.ok(res.json.concurrencyBudget >= 1);
});

test('CLI: --text prints a single human-readable line, not JSON', () => {
  const res = runScript('scripts/capacity.mjs', ['--text', '--no-process-count']);
  assert.equal(res.status, 0, `stderr=${res.stderr}`);
  const out = res.stdout.trim();
  assert.equal(res.json, null, 'text output should not parse as JSON');
  assert.match(out, /GB total/);
  assert.match(out, /GB free/);
  assert.match(out, /concurrent agents/);
});

test('CLI: --per-agent-mb / --headroom-gb / --threshold flags apply', () => {
  const res = runScript('scripts/capacity.mjs', [
    '--no-process-count', '--per-agent-mb', '1000', '--headroom-gb', '1', '--threshold', '1',
  ]);
  assert.equal(res.status, 0, `stderr=${res.stderr}`);
  assert.equal(res.json.perAgentMB, 1000);
  assert.equal(res.json.headroomGB, 1);
  assert.equal(res.json.policy, 'idle-teammates-ok'); // threshold 1 is trivially met
});

// ---------------------------------------------------------------------------
// SessionStart hook: format, gating, and fail-open behaviour
// ---------------------------------------------------------------------------

test('hook: capacity-probe emits a SessionStart additionalContext line', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/capacity-probe.mjs', { session_id: 'sess-cap-1', cwd: dir });
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.ok(res.json, `expected JSON stdout, got: ${res.stdout}`);
    assert.equal(res.json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(res.json.hookSpecificOutput.additionalContext, /^\[agent-companion\] capacity: /);
  } finally {
    cleanup();
  }
});

test('hook: capacity-probe passes through silently when capacity_probe option is off', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/capacity-probe.mjs', { session_id: 'sess-cap-2', cwd: dir }, {
      env: { CLAUDE_PLUGIN_OPTION_CAPACITY_PROBE: 'false' },
    });
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stdout.trim(), '', 'passthrough must produce empty stdout');
  } finally {
    cleanup();
  }
});

test('hook: capacity-probe never throws even when the probe itself is made to fail', () => {
  const { dir, cleanup } = makeFixture();
  try {
    // Point AGENT_COMPANION_STATE_DIR at a file (not a dir) -- the same
    // fail-open shape used by fail-open.test.mjs for the other hooks. The
    // capacity probe does not read state at all, so this mainly documents
    // that a broken environment still cannot crash it; the real safety net
    // is the top-level try/catch around the whole hook body.
    writeFileSync(join(dir, 'blocked-state-dir'), 'not a directory');
    process.env.AGENT_COMPANION_STATE_DIR = join(dir, 'blocked-state-dir');

    const res = runHook('hooks/capacity-probe.mjs', { session_id: 'sess-cap-3', cwd: dir });
    assert.equal(res.status, 0, `capacity-probe must exit 0 even under a broken state dir: stderr=${res.stderr}`);
  } finally {
    cleanup();
  }
});
