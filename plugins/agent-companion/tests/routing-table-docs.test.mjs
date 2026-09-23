// docs/ROUTING.md is GENERATED from config/model-tiers.json — this guards
// against the two drifting apart (a hand-edit to one without regenerating,
// or a config change that was never regenerated).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PLUGIN_ROOT } from './helpers.mjs';

test('docs/ROUTING.md matches a fresh run of scripts/routing-table.mjs', () => {
  const fresh = execFileSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'routing-table.mjs')], {
    encoding: 'utf8', cwd: PLUGIN_ROOT, timeout: 15000,
  });
  const committed = readFileSync(join(PLUGIN_ROOT, 'docs', 'ROUTING.md'), 'utf8');
  assert.equal(committed, fresh, 'docs/ROUTING.md is stale — run: node scripts/routing-table.mjs --out docs/ROUTING.md');
});

test('the generated table includes the effort ladder and reference-model sections', () => {
  const out = execFileSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'routing-table.mjs')], {
    encoding: 'utf8', cwd: PLUGIN_ROOT, timeout: 15000,
  });
  assert.match(out, /## Effort ladder \(cheapest to dearest\)/);
  assert.match(out, /agent-companion:ac-opus-xhigh/);
  assert.match(out, /## Reference models \(older pinned ids — not routable\)/);
  assert.match(out, /opus-4-6/);
});
