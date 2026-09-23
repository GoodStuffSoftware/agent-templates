const test = require('node:test');
const assert = require('node:assert/strict');
const { roundToCents, applyTax } = require('../src/pricing');

test('roundToCents rounds to the nearest cent', () => {
  assert.strictEqual(roundToCents(1.005), 1);
  assert.strictEqual(roundToCents(1.004), 1);
});

test('applyTax adds the given percentage and rounds', () => {
  assert.strictEqual(applyTax(10, 8), 10.8);
});
