// Public inventory API. Delegates all bookkeeping to ledger.js.
const ledger = require('./ledger');

function addStock(sku, qty) {
  return ledger.credit(sku, qty);
}

function removeStock(sku, qty) {
  return ledger.debit(sku, qty);
}

function getStock(sku) {
  return ledger.readCached(sku);
}

function resetStock() {
  ledger.reset();
}

module.exports = { addStock, removeStock, getStock, resetStock };
