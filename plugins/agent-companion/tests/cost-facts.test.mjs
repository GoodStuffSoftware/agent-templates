// Stale cost beliefs that were corrected 2026-10-06 must stay corrected in the
// shipped config and its generated mirror (docs/ROUTING.md): Opus 5.5's plan
// weight is about 1.5x per token and about 1.9x Sonnet per call (not "close to
// Sonnet", not "introductory"), and Fable's plan weight is unverified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';

const cfgText = readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8');
const cfg = JSON.parse(cfgText);
const routing = readFileSync(join(PLUGIN_ROOT, 'docs', 'ROUTING.md'), 'utf8');

test('Opus plan weight: per-token 1.5x and per-call about 1.9x Sonnet are stated; "came close to Sonnet" is gone; "introductory" is not a fact', () => {
  assert.doesNotMatch(cfgText, /came close to Sonnet/);
  assert.doesNotMatch(routing, /came close to Sonnet/);
  assert.match(cfg.costDrivers.readPricePerMTokByTier.note, /about 1\.9x Sonnet/);
  assert.match(cfg.planUsageMultipliersNote, /per CALL at equal context Opus 5\.5 costs about 1\.9x Sonnet/);
  assert.match(routing, /about 1\.9x Sonnet/);
  assert.equal(cfg.planUsageMultipliers.opus.multiplier, 1.5);
  assert.doesNotMatch(cfg.planUsageMultipliers.opus.source, /may be introductory/);
  assert.doesNotMatch(cfg.planUsageMultipliersNote, /This may be an introductory rate/);
  assert.match(cfg.planUsageMultipliersNote, /no evidence it is introductory/);
});

test('Fable plan weight is marked unverified (about 3x fits, not 5x) wherever its cache economics are stated, and has no multiplier', () => {
  assert.equal(cfg.planUsageMultipliers.fable, undefined);
  const mentions = (s) => /UNVERIFIED|unverified/.test(s) && /about 3x/.test(s);
  const note = cfg.tiers.fable.behaviorNotes.find((n) => /cache reads at a quarter/.test(n));
  assert.ok(note && mentions(note), 'the behavior note on Fable cache reads');
  assert.ok(mentions(cfg.calibration['fable-cache-economics'].tension), 'the calibration tension');
  assert.match(routing, /UNVERIFIED[^\n]*about 3x Sonnet, not the 5x/);
  assert.match(routing, /plan weight is unverified \(the data fits about 3x Sonnet, not 5x\)/);
});
