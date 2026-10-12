// 0.31.16 "models": the shipped tier data for Sonnet 5.5 and Haiku 5.5, the price and window
// rows behind them, the plan-unit baseline that must NOT move, and the alias-only wording in
// the setup skill and the shipped routines. Reads the shipped files; no fixtures needed.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';
import { classifyPricing, priceSpecFor, planBaselineModel, planPriceSpecFor } from '../scripts/lib/pricing.mjs';
import { windowSpecFor } from '../scripts/lib/cache-advisor.mjs';

const read = (...p) => readFileSync(join(PLUGIN_ROOT, ...p), 'utf8');
const tiers = JSON.parse(read('config', 'model-tiers.json'));

test('tier ids: sonnet resolves to Sonnet 5.5, haiku to Haiku 5.5', () => {
  assert.equal(tiers.tiers.sonnet.resolvesTo.modelId, 'claude-sonnet-5-5');
  assert.equal(tiers.tiers.haiku.resolvesTo.modelId, 'claude-haiku-5-5');
});

test('haiku tier: Haiku 5.5 facts, efforts with a medium default, 1M context, no retirement before 2027-10-07', () => {
  const h = tiers.tiers.haiku;
  assert.equal(h.resolvesTo.released, '2026-10-07');
  assert.equal(h.resolvesTo.contextTokens, 1000000);
  assert.equal(h.resolvesTo.defaultEffort, 'medium');
  assert.equal(h.resolvesTo.effortSupport, true);
  assert.equal(h.resolvesTo.retirementNotBefore, '2027-10-07');
  assert.deepEqual(h.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('haiku tier: no retired or retiring state, no countdown date, no "no successor" text', () => {
  const h = tiers.tiers.haiku;
  for (const k of ['retiresAfter', 'retired', 'retiredNote', 'replacement']) assert.equal(k in h, false, k);
  const text = JSON.stringify(h);
  assert.doesNotMatch(text, /2026-10-15/);
  assert.doesNotMatch(text, /no successor/i);
  assert.doesNotMatch(text, /RETIRING/);
});

test('nothing in the shipped data or the scout pushes a user off haiku', () => {
  for (const file of [['routines', 'calibration-scout-daily.md'], ['skills', 'calibration-scout', 'SKILL.md'], ['skills', 'setup', 'SKILL.md']]) {
    const text = read(...file);
    assert.doesNotMatch(text, /haiku (is |are )?retir/i, file.join('/'));
    assert.doesNotMatch(text, /migrate off haiku|move off haiku|stop using haiku/i, file.join('/'));
  }
  assert.doesNotMatch(read('agents', 'ac-haiku.md'), /RETIRING|No effort parameter|takes no effort/i);
});

test('ac-haiku is a medium-effort rung and agrees with the ladder', () => {
  const text = read('agents', 'ac-haiku.md');
  assert.match(text, /^model: haiku$/m);
  assert.match(text, /^effort: medium$/m);
  assert.equal(tiers.ladder[0].agent, 'ac-haiku');
  assert.equal(tiers.ladder[0].effort, 'medium');
});

test('pricing rows: Sonnet 5.5 reads at 0.05x ($0.10), Sonnet 5 stays at 0.1x ($0.20), Haiku 5.5 is priced', () => {
  const s55 = classifyPricing('claude-sonnet-5-5');
  const s5 = classifyPricing('claude-sonnet-5');
  const h55 = classifyPricing('claude-haiku-5-5');
  assert.ok(s55.known && s5.known && h55.known);
  assert.equal(s55.in, 2);
  assert.equal(s55.out, 10);
  assert.ok(Math.abs(s55.in * s55.readMultiplier - 0.1) < 1e-9, 'Sonnet 5.5 cache read is $0.10');
  assert.ok(Math.abs(s5.in * s5.readMultiplier - 0.2) < 1e-9, 'Sonnet 5 cache read is $0.20');
  assert.equal(h55.in, 0.1);
  assert.equal(h55.out, 0.5);
  assert.ok(Math.abs(h55.in * h55.readMultiplier - 0.01) < 1e-9, 'Haiku 5.5 cache read is $0.01');
});

test('compaction rows: Sonnet 5.5 and Haiku 5.5 have a 1M window compacting at 967K; Sonnet 4.6 and Haiku 4.5 stay 200K', () => {
  for (const id of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5']) {
    const w = windowSpecFor(id);
    assert.equal(w.contextWindow, 1000000, id);
    assert.equal(w.defaultCompactAt, 967000, id);
  }
  for (const id of ['claude-sonnet-4-6', 'claude-haiku-4-5']) assert.equal(windowSpecFor(id).contextWindow, 200000, id);
});

test('plan units do not move: the plan baseline stays on the Sonnet 5 price vector', () => {
  assert.equal(planBaselineModel(), 'claude-sonnet-5');
  const base = planPriceSpecFor('claude-sonnet-5-5');
  const old = priceSpecFor('claude-sonnet-5');
  assert.equal(base.inUsd, old.inUsd);
  assert.equal(base.outRatio, old.outRatio);
  assert.equal(base.r, old.r);
});

test('older ids stay as reference models, flagged legacy, with the alias to use', () => {
  assert.match(tiers.referenceModels['sonnet-5'].note, /Name the alias `sonnet`/);
  assert.match(tiers.referenceModels['haiku-4-5'].note, /Name the alias `haiku`/);
  assert.deepEqual(tiers.referenceModels['haiku-4-5'].efforts, []);
});

test('setup skill and shipped routines name models by alias, not by a pinned id', () => {
  const pinned = /\b(?:model|--model)[ =:]+["'`]?claude-(?:sonnet|opus|haiku|fable)-\d/i;
  for (const file of [['skills', 'setup', 'SKILL.md'], ['routines', 'calibration-scout-daily.md'], ['skills', 'calibration-scout', 'SKILL.md'], ['skills', 'recommend', 'SKILL.md']]) {
    assert.doesNotMatch(read(...file), pinned, file.join('/'));
  }
  assert.match(read('routines', 'calibration-scout-daily.md'), /--model sonnet /);
  assert.match(read('skills', 'calibration-scout', 'SKILL.md'), /--model sonnet /);
  assert.match(read('skills', 'setup', 'SKILL.md'), /Write the model as its ALIAS \(`sonnet`/);
});

test('the daily routine checks cloud routines through RemoteTrigger and says so when it cannot', () => {
  const text = read('routines', 'calibration-scout-daily.md');
  assert.match(text, /^## STEP 2\.7/m);
  assert.match(text, /RemoteTrigger/);
  assert.match(text, /action: "list"/);
  assert.match(text, /pinned_model_id/);
  assert.match(text, /check was skipped/);
  assert.match(text, /A skipped check is not a clean one/);
});
