const test = require('node:test');
const assert = require('node:assert/strict');
const { processOrder } = require('../src/orders');
const { addStock, getStock, resetStock } = require('../src/inventory');

test('processOrder debits inventory on a valid order', () => {
  resetStock();
  addStock('ABC-1234', 10);
  processOrder('ABC-1234', 4);
  assert.strictEqual(getStock('ABC-1234'), 6);
});

test('processOrder rejects an invalid quantity', () => {
  resetStock();
  addStock('ABC-1234', 10);
  assert.throws(() => processOrder('ABC-1234', -1));
});
