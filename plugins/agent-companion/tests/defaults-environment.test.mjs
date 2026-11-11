// The shipped defaults carry an `environment` block saying what they were measured in (docs/DEFAULTS-ENVIRONMENT.md).
// The block is documentation only: these tests pin that it is present and complete, that no loader's effective
// values change because of it, and that every built-in standing rule has an origin note while the text sessions
// receive is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './isolate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const shipped = (name) => JSON.parse(readFileSync(join(ROOT, 'config', name), 'utf8'));
const strip = ({ environment, ...rest }) => rest;

// The shipped config files whose values were measured in the reference environment (or are public facts, said so).
const MEASURED = ['plan-weights.json', 'model-tiers.json', 'resource-rules.json', 'compaction.json', 'model-pricing.json'];
const KEYS = ['kind', 'describes', 'measured', 'method', 'remeasure'];
const KINDS = ['local-measurement', 'public-fact', 'mixed'];

// One isolated state folder for the loaders, so a user's own override never leaks into a comparison.
const state = mkdtempSync(join(tmpdir(), 'ac-defaults-env-'));
process.env.AGENT_COMPANION_STATE_DIR = state;
process.env.CLAUDE_CONFIG_DIR = state;
test.after(() => { rmSync(state, { recursive: true, force: true }); });

for (const name of MEASURED) {
  test(`${name}: environment block with all required keys`, () => {
    const env = shipped(name).environment;
    assert.ok(env && typeof env === 'object' && !Array.isArray(env), 'environment block missing');
    assert.deepEqual(Object.keys(env), KEYS);
    for (const k of KEYS) assert.ok(typeof env[k] === 'string' && env[k].trim(), `${k} empty`);
    assert.ok(KINDS.includes(env.kind), `kind ${env.kind}`);
    assert.ok(env.remeasure.includes('DEFAULTS-ENVIRONMENT.md'));
    // no user-folder path, machine name or drive path
    assert.doesNotMatch(JSON.stringify(env), /[A-Za-z]:[\\/]|\/Users\/|\/home\//);
  });
}

test('the page exists and the README links it', () => {
  assert.ok(existsSync(join(ROOT, 'docs', 'DEFAULTS-ENVIRONMENT.md')));
  assert.ok(readFileSync(join(ROOT, 'README.md'), 'utf8').includes('docs/DEFAULTS-ENVIRONMENT.md'));
});

test('loaders return the shipped values; the block is the only addition', async () => {
  const { planWeights } = await import('../hooks/lib/plan-allowance.mjs');
  const { pricingTable } = await import('../scripts/lib/pricing.mjs');
  const { compactionConfig } = await import('../scripts/lib/cache-advisor.mjs');
  const { loadRules } = await import('../scripts/lib/resource-rules.mjs');
  const { modelTiers } = await import('../hooks/lib/context.mjs');
  assert.deepEqual(strip(planWeights()), strip(shipped('plan-weights.json')));
  assert.deepEqual(strip(pricingTable()), strip(shipped('model-pricing.json')));
  assert.deepEqual(strip(loadRules({ ...process.env })), strip(shipped('resource-rules.json')));
  assert.deepEqual(strip(modelTiers()), strip(shipped('model-tiers.json')));
  // compaction: defaults fill gaps, so compare the keys the file states
  const comp = compactionConfig();
  for (const [k, v] of Object.entries(strip(shipped('compaction.json')))) assert.deepEqual(comp[k], v, k);
  // the figures consumers read
  assert.equal(planWeights().unitsPerPercent.value, 28.6);
});

test('every built-in standing rule has an origin note', async () => {
  const { defaultRules } = await import('../hooks/lib/rules.mjs');
  const rules = defaultRules();
  assert.equal(rules.length, 12);
  for (const r of rules) assert.ok(typeof r.note === 'string' && r.note.trim().length > 20, `${r.id} has no note`);
});

test('rules.mjs show prints the note', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'rules.mjs'), 'show', 'delegate-first'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENT_COMPANION_STATE_DIR: state },
  });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).note, /^Origin: /);
});

test('the text built-in rules inject is byte-identical to 0.31.51 before the notes', async () => {
  const { defaultRules } = await import('../hooks/lib/rules.mjs');
  const root = (process.env.CLAUDE_PLUGIN_ROOT || ROOT).replace(/\\/g, '/').replace(/\/+$/, '');
  const mask = (x) => (typeof x === 'string' ? x.split(root).join('<root>') : x);
  const rows = defaultRules().map((r) => [r.id, r.then, r.thenLater ?? null, r.after ?? null].map(mask));
  const sha = createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 12);
  // Baseline taken from the settings-home branch before the notes were added. A deliberate wording change updates this hash.
  assert.equal(sha, ['69d1a7', '54f5a7'].join(''));
});
