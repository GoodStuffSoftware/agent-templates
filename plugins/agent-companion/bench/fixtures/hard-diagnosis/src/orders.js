// Order processing: validates, debits inventory, and prices the order.
const inventory = require('./inventory');
const { isValidQty } = require('./validate');
const { applyTax } = require('./pricing');

function processOrder(sku, qty, unitPriceDollars, taxRatePercent) {
  if (!isValidQty(qty)) {
    throw new Error('Invalid quantity');
  }
  inventory.removeStock(sku, qty);
  const subtotal = unitPriceDollars * qty;
  const total = applyTax(subtotal, taxRatePercent);
  return { sku, qty, total };
}

module.exports = { processOrder };
