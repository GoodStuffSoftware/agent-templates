// Order processing: validates, debits inventory, prices the order.
const { removeStock } = require('./inventory');
const { isValidQty } = require('./validate');
const { computeDiscountedPrice, isEligibleForBulkDiscount } = require('./discount');
const { lookupItem } = require('./catalog');

function processOrder(sku, qty) {
  if (!isValidQty(qty)) {
    throw new Error('Invalid quantity');
  }
  removeStock(sku, qty);
  const item = lookupItem(sku);
  if (!item) return null;
  const percentOff = isEligibleForBulkDiscount(qty) ? 15 : 0;
  const unitPrice = computeDiscountedPrice(item.priceCents, percentOff);
  return { sku, qty, unitPriceCents: unitPrice, totalCents: unitPrice * qty };
}

module.exports = { processOrder };
