// Low-level stock ledger. inventory.js is a thin wrapper around this.
let table = {};
let cache = {};

function credit(sku, qty) {
  table[sku] = (table[sku] || 0) + qty;
  cache[sku] = table[sku];
  return table[sku];
}

function debit(sku, qty) {
  if (!table[sku] || table[sku] < qty) {
    throw new Error(`Insufficient stock for ${sku}`);
  }
  table[sku] -= qty;
  return table[sku];
}

function readCached(sku) {
  return cache[sku] || 0;
}

function reset() {
  table = {};
  cache = {};
}

module.exports = { credit, debit, readCached, reset };
