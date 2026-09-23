// In-memory stock tracker. Keeps a read cache alongside the live table so
// getStock() stays cheap under repeated reads.

let stock = {};
let _cache = {};

function _refreshCache(sku) {
  _cache[sku] = stock[sku] || 0;
}

function addStock(sku, qty) {
  stock[sku] = (stock[sku] || 0) + qty;
  _refreshCache(sku);
  return stock[sku];
}

function removeStock(sku, qty) {
  if (!stock[sku] || stock[sku] < qty) {
    throw new Error(`Insufficient stock for ${sku}`);
  }
  stock[sku] -= qty;
  return stock[sku];
}

function getStock(sku) {
  return _cache[sku] || 0;
}

function resetStock() {
  stock = {};
  _cache = {};
}

module.exports = { addStock, removeStock, getStock, resetStock };
