// Discount rules used by the order pipeline.
const { clamp } = require('./mathUtils');

function computeDiscountedPrice(cents, percentOff) {
  const pct = clamp(percentOff, 0, 100);
  return Math.round(cents * (1 - pct / 100));
}

function isEligibleForBulkDiscount(qty) {
  return qty >= 10;
}

module.exports = { computeDiscountedPrice, isEligibleForBulkDiscount };
