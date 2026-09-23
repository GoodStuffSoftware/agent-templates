const test = require('node:test');
const assert = require('node:assert/strict');
const { processOrder } = require('../src/orders');
const { addStock, getStock, resetStock } = require('../src/inventory');

test('processOrder debits inventory and getStock reflects it afterward', () => {
  resetStock();
  addStock('ABC-1234', 10);
  processOrder('ABC-1234', 4, 2.5, 8);
  assert.strictEqual(getStock('ABC-1234'), 6);
});

test('processOrder computes a taxed total', () => {
  resetStock();
  addStock('ABC-1234', 10);
  const result = processOrder('ABC-1234', 2, 5, 10);
  assert.strictEqual(result.total, 11);
});

test('processOrder rejects an invalid quantity', () => {
  resetStock();
  addStock('ABC-1234', 10);
  assert.throws(() => processOrder('ABC-1234', -1, 5, 10));
});
