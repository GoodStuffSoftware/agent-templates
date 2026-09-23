const test = require('node:test');
const assert = require('node:assert/strict');
const { add, clamp, average } = require('../src/mathUtils');

test('add sums two numbers', () => {
  assert.strictEqual(add(2, 3), 5);
});

test('clamp bounds a value to [min, max]', () => {
  assert.strictEqual(clamp(15, 0, 10), 10);
  assert.strictEqual(clamp(-5, 0, 10), 0);
  assert.strictEqual(clamp(5, 0, 10), 5);
});

test('average computes the mean of a list', () => {
  assert.strictEqual(average([2, 4, 6]), 4);
  assert.strictEqual(average([]), 0);
});
