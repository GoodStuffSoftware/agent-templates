// Order processing: validates and debits inventory.

const { removeStock } = require('./inventory');
const { isValidQty } = require('./validate');

function processOrder(sku, qty) {
  if (!isValidQty(qty)) {
    throw new Error('Invalid quantity');
  }
  return removeStock(sku, qty);
}

module.exports = { processOrder };
