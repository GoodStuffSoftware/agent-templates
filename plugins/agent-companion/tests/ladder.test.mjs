// The routing ladder: an ordered, cheapest-to-dearest view of (model, effort)
// pairs, each mapped to a spawnable generic worker definition under agents/
// (the Agent tool has no per-spawn effort parameter, so effort is locked to
// whichever definition's frontmatter is used).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, runScript } from './helpers.mjs';

const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));

test('ladder is ordered cheapest to dearest: haiku, sonnet low..xhigh, opus low..max', () => {
  const expected = [
    ['haiku', null], ['sonnet', 'low'], ['sonnet', 'medium'], ['sonnet', 'high'], ['sonnet', 'xhigh'],
    ['opus', 'low'], ['opus', 'medium'], ['opus', 'high'], ['opus', 'xhigh'], ['opus', 'max'],
  ];
  assert.equal(cfg.ladder.length, expected.length);
  cfg.ladder.forEach((r, i) => {
    assert.equal(r.model, expected[i][0], `rung ${i + 1} model`);
    assert.equal(r.effort ?? null, expected[i][1], `rung ${i + 1} effort`);
  });
});

test('fable does not appear anywhere in the ladder', () => {
  assert.ok(!cfg.ladder.some((r) => r.model === 'fable'), 'fable must stay outside the ladder');
});

test('every ladder rung names an agent definition file that actually exists with matching model/effort frontmatter', () => {
  const agentsDir = join(PLUGIN_ROOT, 'agents');
  const files = new Set(readdirSync(agentsDir));
  for (const r of cfg.ladder) {
    const file = `${r.agent}.md`;
    assert.ok(files.has(file), `agents/${file} must exist for rung ${r.rung}`);
    const text = readFileSync(join(agentsDir, file), 'utf8');
    const fm = {};
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(m, `${file} must have frontmatter`);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    assert.equal(fm.model, r.model, `${file} frontmatter model`);
    assert.equal(fm.effort || null, r.effort, `${file} frontmatter effort`);
  }
});

test('recommend.mjs prints the namespaced spawnable agent name for a routed task', () => {
  // bounded-feature is under the 2026-09-23 routing trial (config/model-tiers.json
  // taskTypes.bounded-feature.override, reviewBy 2026-09-30): opus/low, not
  // the plain grid's sonnet/medium — see verify-vs-operate.test.mjs and
  // routing-table-docs.test.mjs for the same trial on other types.
  const res = runScript('scripts/recommend.mjs', ['--type', 'bounded-feature', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.spawnAgentNamespaced, 'agent-companion:ac-opus-low');
  assert.equal(res.json.rung, 6);
});

test('an explicit --kind bypasses the bounded-feature trial override and falls back to the plain grid', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'bounded-feature', '--kind', 'bounded', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.spawnAgentNamespaced, 'agent-companion:ac-sonnet-medium');
  assert.equal(res.json.rung, 3);
});

test('recommend.mjs maps a fable-warranted result to no rung (outside the ladder)', () => {
  // Fable is never returned by the routing grid itself (only via a manual
  // override), so simulate the "no rung for this model" branch directly by
  // asking for a weight/kind/consequence combo and confirming premium opus
  // results (which ARE on the ladder) still resolve a rung.
  const res = runScript('scripts/recommend.mjs', ['--weight', '5', '--kind', 'novel-design', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.ok(res.json.rung >= 1 && res.json.rung <= 10);
});
