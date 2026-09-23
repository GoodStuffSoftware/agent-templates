const test = require('node:test');
const assert = require('node:assert/strict');
const { addStock, removeStock, getStock, resetStock } = require('../src/inventory');

test('addStock increases the running total', () => {
  resetStock();
  addStock('ABC-1234', 10);
  assert.strictEqual(getStock('ABC-1234'), 10);
});

test('removeStock decreases the running total', () => {
  resetStock();
  addStock('ABC-1234', 10);
  removeStock('ABC-1234', 4);
  assert.strictEqual(getStock('ABC-1234'), 6);
});

test('removeStock throws when stock is insufficient', () => {
  resetStock();
  addStock('ABC-1234', 2);
  assert.throws(() => removeStock('ABC-1234', 5));
});
