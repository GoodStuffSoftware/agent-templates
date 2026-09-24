// bench/runner.mjs's per-run budget cap must scale with the cell's model
// price relative to Sonnet 5 (config/model-tiers.json's own pricing table),
// or a pricier model doing the SAME amount of real work gets cut off by
// --max-budget-usd before the task is actually done. Live finding
// (2026-09-23): Fable failed 7 real-task runs purely by hitting
// Sonnet-sized caps — the model was still working when the CLI killed the
// run for "exceeding" a budget calibrated for a model at a fifth of its
// price.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CELLS, modelPriceRatioToSonnet, scaledMaxBudgetUsd } from '../bench/runner.mjs';

// --- CELLS additions ---------------------------------------------------

test('CELLS carries fable51-{low,medium,high,xhigh} on claude-fable-5-1', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    const id = `fable51-${effort}`;
    assert.ok(CELLS[id], `missing cell ${id}`);
    assert.equal(CELLS[id].model, 'claude-fable-5-1');
    assert.equal(CELLS[id].effort, effort);
  }
});

test('CELLS carries fable5-high on claude-fable-5', () => {
  assert.ok(CELLS['fable5-high'], 'missing cell fable5-high');
  assert.equal(CELLS['fable5-high'].model, 'claude-fable-5');
  assert.equal(CELLS['fable5-high'].effort, 'high');
});

// --- modelPriceRatioToSonnet --------------------------------------------

test('sonnet is the baseline: ratio is exactly 1', () => {
  assert.equal(modelPriceRatioToSonnet('claude-sonnet-5'), 1);
});

test('opus 5.5 (current tier pricing $4/$20 vs sonnet $2/$10) is 2x', () => {
  assert.equal(modelPriceRatioToSonnet('claude-opus-5-5'), 2);
});

test('fable 5.1 ($10/$50 vs sonnet $2/$10) is 5x', () => {
  assert.equal(modelPriceRatioToSonnet('claude-fable-5-1'), 5);
});

test('haiku ($1/$5 vs sonnet $2/$10) is 0.5x — cheaper models are NOT excluded from ratio computation, only from the scaling floor', () => {
  assert.equal(modelPriceRatioToSonnet('claude-haiku-4-5'), 0.5);
});

test('a dated reference id (claude-opus-5, $5/$25) uses its OWN historical pricing, not the current opus tier\'s ($4/$20)', () => {
  // If this fell through to the current `opus` alias tier instead of the
  // referenceModels entry, it would report 2 (4/2), not 2.5 (5/2).
  assert.equal(modelPriceRatioToSonnet('claude-opus-5'), 2.5);
});

test('a dated fable-5 reference id ($10/$50, same as 5.1\'s current price) still resolves to 5x', () => {
  assert.equal(modelPriceRatioToSonnet('claude-fable-5'), 5);
});

test('an unrecognised model id fails open to 1 (no scaling), never guessed', () => {
  assert.equal(modelPriceRatioToSonnet('claude-totally-unknown-model-9000'), 1);
});

// --- scaledMaxBudgetUsd --------------------------------------------------

test('scaledMaxBudgetUsd leaves a Sonnet cell\'s cap untouched', () => {
  assert.equal(scaledMaxBudgetUsd(0.6, 'claude-sonnet-5'), 0.6);
});

test('scaledMaxBudgetUsd scales a Fable cell\'s cap up 5x — the exact fix for the 7 real-task cutoffs', () => {
  assert.equal(scaledMaxBudgetUsd(1.2, 'claude-fable-5-1'), 6);
});

test('scaledMaxBudgetUsd scales an Opus 5.5 cell\'s cap up 2x', () => {
  assert.equal(scaledMaxBudgetUsd(0.8, 'claude-opus-5-5'), 1.6);
});

test('scaledMaxBudgetUsd floors at 1x for a cheaper model (haiku) — never tightens an existing cap', () => {
  assert.equal(scaledMaxBudgetUsd(0.6, 'claude-haiku-4-5'), 0.6);
});
