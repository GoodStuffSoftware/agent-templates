const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPrice, formatSku } = require('../src/format');

test('formatPrice renders cents as a dollar string', () => {
  assert.strictEqual(formatPrice(1050), '$10.50');
  assert.strictEqual(formatPrice(5), '$0.05');
});

test('formatSku uppercases and trims', () => {
  assert.strictEqual(formatSku(' abc-1234 '), 'ABC-1234');
});
