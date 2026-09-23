const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidSku, isValidQty } = require('../src/validate');

test('isValidSku requires AAA-9999 shape', () => {
  assert.strictEqual(isValidSku('ABC-1234'), true);
  assert.strictEqual(isValidSku('abc-1234'), false);
  assert.strictEqual(isValidSku('AB-1234'), false);
});

test('isValidQty requires a positive integer', () => {
  assert.strictEqual(isValidQty(3), true);
  assert.strictEqual(isValidQty(0), false);
  assert.strictEqual(isValidQty(-1), false);
  assert.strictEqual(isValidQty(1.5), false);
});
