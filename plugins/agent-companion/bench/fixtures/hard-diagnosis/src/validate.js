// Input validation for the order pipeline.

function isValidSku(sku) {
  return /^[A-Z]{3}-\d{4}$/.test(sku);
}

function isValidQty(qty) {
  return Number.isInteger(qty) && qty > 0;
}

module.exports = { isValidSku, isValidQty };
