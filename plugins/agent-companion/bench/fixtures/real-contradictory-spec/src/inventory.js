// In-memory stock tracker. One process-wide table.

let stock = {};

function addStock(sku, qty) {
  stock[sku] = (stock[sku] || 0) + qty;
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
  return stock[sku] || 0;
}

function resetStock() {
  stock = {};
}

module.exports = { addStock, removeStock, getStock, resetStock };
