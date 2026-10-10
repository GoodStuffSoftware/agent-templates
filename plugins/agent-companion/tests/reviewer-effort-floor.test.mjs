// reviewerEffortFloor (0.31.10): the mirror of reviewerEffortCap. A NON-critical
// review on a floored model runs at LEAST at the floor even when its writer ran
// lower (operator decision 2026-10-09 5a: a sonnet writer's review runs at
// sonnet/xhigh at any writer effort). The recommender (resolveRoute), the spawn
// guard's parity route and the self-review text a spawn appends to a writer's
// brief (the reviewer rung) all read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, runScript, readJsonl } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const sr = await import('../hooks/lib/self-review.mjs');

const ROLLOUT = join(fx.stateDir, 'rollout.json');
const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;
const FLOOR = { sonnet: { effort: 'xhigh' } };
const CAP = { opus: { effort: 'high', activeFrom: 'opus-review-high', exceptWriterTypes: ['novel-design', 'critical-change'] } };
const BEFORE = '2026-10-10T12:00:00Z';
const AFTER = '2026-10-11T08:00:00Z';

function setRollout(obj) {
  mkdirSync(fx.stateDir, { recursive: true });
  writeFileSync(ROLLOUT, JSON.stringify(obj));
}
const review = (writer, { consequence, writerType, now = BEFORE } = {}) => {
  const [model, effort] = writer.split('/');
  return ctx.resolveRoute({
    type: 'code-review', writer: { model, effort: effort || '' }, now, writerType: writerType || null,
    ...(consequence ? { consequence, consequenceExplicit: true } : {}),
  });
};
function withTiers(patch, fn) {
  const tiers = ctx.modelTiers();
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = tiers[k]; tiers[k] = patch[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) tiers[k] = saved[k]; }
}

test('shipped: no floor, parity unchanged', () => {
  assert.deepEqual(ctx.modelTiers().reviewerEffortFloor, {});
  for (const w of ['sonnet/low', 'sonnet/medium', 'sonnet/high', 'sonnet/xhigh']) assert.equal(label(review(w)), w);
});

test('a sonnet floor: every sonnet writer effort gets a sonnet/xhigh review; nothing else moves', () => withTiers({ reviewerEffortFloor: FLOOR }, () => {
  for (const w of ['sonnet/low', 'sonnet/medium', 'sonnet/high', 'sonnet/xhigh']) {
    const r = review(w);
    assert.equal(label(r), 'sonnet/xhigh', w);
    if (w !== 'sonnet/xhigh') assert.ok(r.floorsApplied.some((f) => f.floor === 'F3' && /reviewerEffortFloor/.test(f.raised || '')), `${w}: the floor is recorded`);
    else assert.ok(!r.floorsApplied.some((f) => /reviewerEffortFloor/.test(f.raised || '')), 'xhigh writer: nothing to raise');
  }
  // Opus is untouched, and a floor never lowers.
  for (const w of ['opus/medium', 'opus/high', 'opus/xhigh', 'opus/max']) assert.equal(label(review(w)), w);
  // A critical review is sized by F1 (opus/xhigh), with or without the floor.
  for (const w of ['sonnet/medium', 'sonnet/high', 'sonnet/xhigh']) assert.equal(label(review(w, { consequence: 'critical' })), 'opus/xhigh', w);
  assert.equal(label(review('opus/xhigh', { consequence: 'critical' })), 'opus/xhigh');
  // A writer whose effort is not stated counts as below the floor; a model that takes no effort stays as it is.
  assert.equal(label(review('sonnet')), 'sonnet/xhigh');
  assert.equal(label(review('opus')), 'opus');
  // An elevated change keeps its own effort floor and the sonnet floor is at least as high.
  assert.equal(label(review('sonnet/medium', { consequence: 'elevated' })), 'sonnet/xhigh');
}));

test('both the sonnet floor and the opus cap, before and after the cap date (the live user layer)', () => withTiers({ reviewerEffortFloor: FLOOR, reviewerEffortCap: CAP }, () => {
  setRollout({ 'opus-review-high': '2026-10-11T08:00:00Z' });
  for (const [now, opusX, opusMax] of [[BEFORE, 'opus/xhigh', 'opus/max'], [AFTER, 'opus/high', 'opus/high']]) {
    for (const w of ['sonnet/medium', 'sonnet/high', 'sonnet/xhigh']) assert.equal(label(review(w, { now })), 'sonnet/xhigh', `${w} @ ${now}`);
    assert.equal(label(review('opus/xhigh', { now })), opusX, `opus/xhigh @ ${now}`);
    assert.equal(label(review('opus/max', { now })), opusMax, `opus/max @ ${now}`);
    // Critical and the excepted types keep opus/xhigh at any date.
    assert.equal(label(review('opus/xhigh', { consequence: 'critical', now })), 'opus/xhigh');
    assert.equal(label(review('opus/xhigh', { writerType: 'novel-design', now })), 'opus/xhigh');
    assert.equal(label(review('opus/xhigh', { writerType: 'critical-change', now })), 'opus/xhigh');
    assert.equal(label(review('sonnet/high', { consequence: 'critical', now })), 'opus/xhigh');
  }
}));

test('floor: activeFrom schedules it, exceptWriterTypes keep parity, unusable shapes are ignored', () => {
  setRollout({ 'sonnet-xhigh': '2026-10-11T08:00:00Z' });
  withTiers({ reviewerEffortFloor: { sonnet: { effort: 'xhigh', activeFrom: 'sonnet-xhigh', exceptWriterTypes: ['mechanical-edit'] } } }, () => {
    assert.equal(label(review('sonnet/medium', { now: BEFORE })), 'sonnet/medium', 'not yet active');
    assert.equal(label(review('sonnet/medium', { now: AFTER })), 'sonnet/xhigh');
    assert.equal(label(review('sonnet/medium', { now: AFTER, writerType: 'mechanical-edit' })), 'sonnet/medium', 'excepted type keeps parity');
    assert.equal(label(review('sonnet/medium', { now: AFTER, writerType: 'bounded-feature' })), 'sonnet/xhigh');
  });
  for (const bad of [{ sonnet: { effort: 'turbo' } }, { sonnet: { effort: 'xhigh', activeFrom: 'no-such-id' } }, 'garbage', [], { sonnet: 'xhigh' }, { haiku: { effort: 'xhigh' } }]) {
    withTiers({ reviewerEffortFloor: bad }, () => {
      assert.equal(label(review('sonnet/medium', { now: AFTER })), 'sonnet/medium', JSON.stringify(bad));
    });
  }
  rmSync(ROLLOUT, { force: true });
});

test('recommend.mjs: code-review for each writer, floor + cap, before and after the cap date', () => {
  const f = makeFixture();
  try {
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(join(f.stateDir, 'model-tiers.json'), JSON.stringify({ reviewerEffortFloor: FLOOR, reviewerEffortCap: CAP }));
    writeFileSync(join(f.stateDir, 'rollout.json'), JSON.stringify({ 'opus-review-high': '2026-10-11T08:00:00Z' }));
    const run = (writer, extra, now) => {
      const res = runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', writer, '--json', ...extra], {
        cwd: f.dir, env: { AGENT_COMPANION_FAKE_NOW: now },
      });
      assert.equal(res.status, 0, res.stderr);
      return `${res.json.model}/${res.json.effort}`;
    };
    for (const now of [BEFORE, AFTER]) {
      for (const w of ['sonnet/medium', 'sonnet/high', 'sonnet/xhigh']) assert.equal(run(w, [], now), 'sonnet/xhigh', `${w} @ ${now}`);
      assert.equal(run('opus/xhigh', ['--consequence', 'critical'], now), 'opus/xhigh');
    }
    assert.equal(run('opus/xhigh', [], BEFORE), 'opus/xhigh');
    assert.equal(run('opus/xhigh', [], AFTER), 'opus/high');
    const res = runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'sonnet/medium', '--json'], { cwd: f.dir, env: { AGENT_COMPANION_FAKE_NOW: BEFORE } });
    assert.equal(res.json.spawnAgent, 'ac-sonnet-xhigh');
    // A writer route's own reviewer line says so.
    const wr = runScript('scripts/recommend.mjs', ['--type', 'mechanical-edit', '--json'], { cwd: f.dir, env: { AGENT_COMPANION_FAKE_NOW: BEFORE } });
    assert.equal(wr.status, 0, wr.stderr);
    assert.equal(`${wr.json.model}/${wr.json.effort}`, 'sonnet/low');
    assert.equal(wr.json.reviewer.effort, 'xhigh');
    assert.match(wr.json.reviewer.note, /reviewerEffortFloor/);
    assert.match(wr.json.reviewer.note, /above the writer's/);
  } finally {
    f.cleanup();
  }
});

test('reviewerRungFor: the recommender\'s rung on the same model, else null (generated rung text never depends on it)', () => withTiers({ reviewerEffortFloor: FLOOR }, () => {
  const rung = (m, e) => ctx.rungFor(m, e);
  assert.equal(sr.reviewerRungFor(rung('sonnet', 'medium'), { now: BEFORE }).agent, 'ac-sonnet-xhigh');
  assert.equal(sr.reviewerRungFor(rung('sonnet', 'high'), { now: BEFORE }).agent, 'ac-sonnet-xhigh');
  assert.equal(sr.reviewerRungFor(rung('sonnet', 'xhigh'), { now: BEFORE }), null);
  assert.equal(sr.reviewerRungFor(rung('opus', 'xhigh'), { now: BEFORE }), null);
  // Critical moves to another model: keep the writer's own rung, as before.
  assert.equal(sr.reviewerRungFor(rung('sonnet', 'high'), { now: BEFORE, consequence: 'critical' }), null);
  assert.equal(sr.reviewerRungFor(null), null);
  // The generated block (no reviewer rung) is the same text it always was.
  const r = rung('sonnet', 'high');
  const plain = sr.selfReviewBlock(r, sr.selfReviewConfig());
  assert.match(plain, /subagent_type: "agent-companion:ac-sonnet-high"/);
  assert.match(plain, /this rung, which matches your own model and effort/);
  const raised = sr.selfReviewBlock(r, sr.selfReviewConfig(), 'agent-companion', rung('sonnet', 'xhigh'));
  assert.match(raised, /subagent_type: "agent-companion:ac-sonnet-xhigh"/);
  assert.match(raised, /^ {3}WRITER: sonnet\/high$/m, 'the WRITER line stays the writer\'s own pair');
  assert.match(raised, /sonnet\/xhigh, not your own rung/);
}));

test('spawn guard: the self-review text appended to a sonnet writer names the reviewer rung the recommender names', () => {
  const f = makeFixture();
  try {
    const sid = 'sess-floor';
    const env = { CLAUDE_PLUGIN_DATA: join(f.dir, '.claude', 'plugins', 'data', 'agent-companion-x'), CLAUDE_PLUGIN_OPTION_PREMIUM_MAX_CONCURRENT: '50' };
    const projDir = join(f.dir, 'projects', 'proj');
    mkdirSync(projDir, { recursive: true });
    const transcript = join(projDir, `${sid}.jsonl`);
    writeFileSync(transcript, '');
    const spawn = (agent, prompt, extraEnv = {}) => {
      const res = runHook('hooks/spawn-guard.mjs', {
        hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: sid, cwd: f.dir, transcript_path: transcript,
        tool_input: { subagent_type: `agent-companion:${agent}`, run_in_background: false, prompt },
      }, { env: { ...env, ...extraEnv } });
      assert.equal(res.status, 0, res.stderr);
      return res.json?.hookSpecificOutput?.updatedInput?.prompt ?? '';
    };
    const brief = 'TYPE: bounded-feature\ndo a thing';
    // No floor (shipped): the writer's own rung.
    for (const [agent, pair] of [['ac-sonnet-medium', 'sonnet/medium'], ['ac-sonnet-high', 'sonnet/high']]) {
      const p = spawn(agent, brief);
      assert.match(p, new RegExp(`subagent_type: "agent-companion:${agent}"`), `${agent} unfloored`);
      assert.match(p, new RegExp(`^ {3}WRITER: ${pair}$`, 'm'));
    }
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(join(f.stateDir, 'model-tiers.json'), JSON.stringify({ reviewerEffortFloor: FLOOR }));
    for (const [agent, pair] of [['ac-sonnet-medium', 'sonnet/medium'], ['ac-sonnet-high', 'sonnet/high']]) {
      const p = spawn(agent, brief);
      assert.match(p, /subagent_type: "agent-companion:ac-sonnet-xhigh"/, `${agent} floored`);
      assert.match(p, new RegExp(`^ {3}WRITER: ${pair}$`, 'm'), 'the WRITER line is still the writer\'s own pair');
      assert.match(p, /sonnet\/xhigh, not your own rung/);
    }
    // sonnet/xhigh already is the floor: its own rung.
    const x = spawn('ac-sonnet-xhigh', brief);
    assert.match(x, /subagent_type: "agent-companion:ac-sonnet-xhigh"/);
    assert.doesNotMatch(x, /not your own rung/);
    // A critical change keeps the writer's rung in the text (the recommender moves it to opus; unchanged).
    const c = spawn('ac-sonnet-high', 'TYPE: bounded-feature\nCONSEQUENCE: critical\ndo a thing');
    assert.match(c, /subagent_type: "agent-companion:ac-sonnet-high"/);
  } finally {
    f.cleanup();
  }
});
