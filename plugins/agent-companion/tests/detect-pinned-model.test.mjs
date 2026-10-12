// The scout's model-id signals (scripts/detect.mjs): pinned_model_id (a full id pinned where
// the alias would do) and model_tier_data_changed (a tier's id moved in the tier data), and
// their reach into the decision register's `signal` triggers. Synthetic fixtures only.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';

const write = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const kind = (res, k) => (res.json?.signals || []).filter((s) => s.kind === k);

function run(dir, env = {}) {
  const res = runScript('scripts/detect.mjs', [], { cwd: dir, env, timeout: 90000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.json, 'detect prints JSON');
  return res;
}
const task = (dir, name, text) => write(join(dir, '.claude', 'scheduled-tasks', name, 'SKILL.md'), text);

test('a pinned id in a scheduled task fires once, names the place and the alias, then stays quiet', () => {
  const { dir, cleanup } = makeFixture();
  try {
    task(dir, 'nightly', 'Run it.\nmodel: claude-sonnet-5\n');
    const first = kind(run(dir), 'pinned_model_id');
    assert.equal(first.length, 1);
    assert.equal(first[0].dispatch, 'manual-check');
    assert.match(first[0].detail, /scheduled task nightly pins claude-sonnet-5/);
    assert.match(first[0].detail, /use "sonnet"/);
    assert.equal(kind(run(dir), 'pinned_model_id').length, 0, 'known pin: no repeat');
    task(dir, 'weekly', 'model: claude-haiku-4-5\n');
    const third = kind(run(dir), 'pinned_model_id');
    assert.equal(third.length, 1);
    assert.match(third[0].detail, /scheduled task weekly/);
    assert.doesNotMatch(third[0].detail, /nightly/, 'only the new pin');
  } finally { cleanup(); }
});

test('pins in settings and in agent definitions are found', () => {
  const { dir, cleanup } = makeFixture();
  try {
    write(join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }));
    write(join(dir, '.claude', 'agents', 'old.md'), '---\nname: old\nmodel: claude-haiku-4-5\n---\nBody\n');
    const hit = kind(run(dir), 'pinned_model_id');
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /2 pinned model id/);
    assert.match(hit[0].detail, /user settings model pins claude-opus-5/);
    assert.match(hit[0].detail, /user agent old\.md pins claude-haiku-4-5/);
  } finally { cleanup(); }
});

test('aliases everywhere: no signal', () => {
  const { dir, cleanup } = makeFixture();
  try {
    task(dir, 'nightly', 'model: sonnet\n');
    write(join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    write(join(dir, '.claude', 'agents', 'a.md'), '---\nname: a\nmodel: haiku\n---\n');
    assert.equal(kind(run(dir), 'pinned_model_id').length, 0);
  } finally { cleanup(); }
});

test('option pinned_model_check=false turns the scan off', () => {
  const { dir, cleanup } = makeFixture();
  try {
    task(dir, 'nightly', 'model: claude-sonnet-5\n');
    assert.equal(kind(run(dir, { CLAUDE_PLUGIN_OPTION_PINNED_MODEL_CHECK: 'false' }), 'pinned_model_id').length, 0);
    assert.equal(kind(run(dir), 'pinned_model_id').length, 1, 'default on: the same pin is reported');
  } finally { cleanup(); }
});

test('scout_suppress drops the signal', () => {
  const { dir, cleanup } = makeFixture();
  try {
    task(dir, 'nightly', 'model: claude-sonnet-5\n');
    assert.equal(kind(run(dir, { CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'pinned_model_id' }), 'pinned_model_id').length, 0);
  } finally { cleanup(); }
});

test('the option is declared in plugin.json with default true', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.userConfig.pinned_model_check.type, 'boolean');
  assert.equal(manifest.userConfig.pinned_model_check.default, true);
});

// --- model_tier_data_changed -------------------------------------------------------------

async function baselineFile() {
  const { stateFile } = await import('../hooks/lib/context.mjs');
  return stateFile('baseline.json');
}

test('model_tier_data_changed: a tier id that differs from the recorded one fires, then the new id is recorded', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const file = await baselineFile();
    write(file, JSON.stringify({ checkedAt: '2026-10-01T00:00:00.000Z', knownModelAliases: ['haiku', 'sonnet', 'opus', 'fable', 'mythos'], knownTierModelIds: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5' } }));
    const hit = kind(run(dir), 'model_tier_data_changed');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].dispatch, 'none');
    assert.match(hit[0].detail, /haiku claude-haiku-4-5 -> claude-haiku-5-5/);
    assert.match(hit[0].detail, /sonnet claude-sonnet-5 -> claude-sonnet-5-5/);
    assert.equal(kind(run(dir), 'model_tier_data_changed').length, 0, 'recorded: no repeat');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).knownTierModelIds.haiku, 'claude-haiku-5-5');
  } finally { cleanup(); }
});

test('model_tier_data_changed: a baseline from before the signal fires once with the ids named now; a fresh install is silent', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    assert.equal(kind(run(dir), 'model_tier_data_changed').length, 0, 'no baseline at all');
    const file = await baselineFile();
    write(file, JSON.stringify({ checkedAt: '2026-10-01T00:00:00.000Z', knownModelAliases: ['haiku', 'sonnet', 'opus'] }));
    const hit = kind(run(dir), 'model_tier_data_changed');
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /haiku claude-haiku-5-5/);
    assert.match(hit[0].detail, /sonnet claude-sonnet-5-5/);
    assert.equal(kind(run(dir), 'model_tier_data_changed').length, 0);
  } finally { cleanup(); }
});

// --- the decision register's `signal` triggers -----------------------------------------------

function registerWith(trigger) {
  return {
    schema: 'agent-companion/decision-register',
    version: 1,
    decisions: [{
      id: 'small-model-call', title: 'Small model call', status: 'active', decided: '2026-10-10',
      decision: 'Keep the small-model routing.', reverse: 'Edit the routing rows.',
      premises: [{ id: 'p1', text: 'No newer small model exists.', label: 'E' }],
      evidence: ['notes/evidence.md'],
      triggers: [trigger],
    }],
  };
}

async function registerPaths() {
  const { configDir } = await import('../hooks/lib/context.mjs');
  const reg = await import('../scripts/lib/decision-register.mjs');
  return { registerFile: join(configDir(), 'decision-register.json'), statePath: reg.statePath() };
}

test('a pinned_model_id signal flags a decision whose trigger listens to it, once, and the scout reports the review', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { registerFile, statePath } = await registerPaths();
    write(registerFile, JSON.stringify(registerWith({ id: 'model-pin', premise: 'p1', kind: 'signal', signalKinds: ['pinned_model_id', 'model_tier_data_changed'] })));
    task(dir, 'nightly', 'model: claude-sonnet-5\n');
    const first = run(dir);
    assert.equal(kind(first, 'pinned_model_id').length, 1);
    const due = kind(first, 'decision_review_due');
    assert.equal(due.length, 1);
    assert.match(due[0].detail, /small-model-call/);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const flags = Object.values(state.flags);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].kind, 'signal');
    assert.match(flags[0].summary, /scout pinned_model_id/);
    // The same pin is known now: no new signal, no new flag.
    run(dir);
    assert.equal(Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).flags).length, 1);
  } finally { cleanup(); }
});

test('a decision with no signal trigger is not flagged by a pin; opting out of the register stops the scan', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { registerFile, statePath } = await registerPaths();
    write(registerFile, JSON.stringify(registerWith({ id: 'cl', premise: 'p1', kind: 'changelog', sinceVersion: '2.1.296', pattern: 'haiku' })));
    task(dir, 'nightly', 'model: claude-sonnet-5\n');
    const res = run(dir);
    assert.equal(kind(res, 'decision_review_due').length, 0);
    assert.ok(!existsSync(statePath) || Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).flags || {}).length === 0);
  } finally { cleanup(); }

  const second = makeFixture();
  try {
    const { registerFile, statePath } = await registerPaths();
    write(registerFile, JSON.stringify(registerWith({ id: 'model-pin', premise: 'p1', kind: 'signal', signalKinds: ['pinned_model_id'] })));
    task(second.dir, 'nightly', 'model: claude-sonnet-5\n');
    const res = run(second.dir, { CLAUDE_PLUGIN_OPTION_DECISION_REGISTER: 'false' });
    assert.equal(kind(res, 'pinned_model_id').length, 1, 'the signal itself still fires');
    assert.equal(kind(res, 'decision_review_due').length, 0);
    assert.ok(!existsSync(statePath) || Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).flags || {}).length === 0);
  } finally { second.cleanup(); }
});

test('a model_tier_data_changed signal reaches a signal trigger even though no CLI changelog item exists', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { registerFile, statePath } = await registerPaths();
    write(registerFile, JSON.stringify(registerWith({ id: 'tier-move', premise: 'p1', kind: 'signal', signalKinds: ['model_tier_data_changed'], pattern: 'haiku' })));
    write(await baselineFile(), JSON.stringify({ checkedAt: '2026-10-01T00:00:00.000Z', knownModelAliases: ['haiku', 'sonnet'], knownTierModelIds: { haiku: 'claude-haiku-4-5' } }));
    const res = run(dir);
    assert.equal(kind(res, 'model_tier_data_changed').length, 1);
    assert.equal(kind(res, 'decision_review_due').length, 1);
    const flag = Object.values(JSON.parse(readFileSync(statePath, 'utf8')).flags)[0];
    assert.equal(flag.trigger, 'tier-move');
    assert.match(flag.summary, /claude-haiku-4-5 -> claude-haiku-5-5/);
  } finally { cleanup(); }
});
