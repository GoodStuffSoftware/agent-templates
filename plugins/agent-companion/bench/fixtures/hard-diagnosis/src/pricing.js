// Pricing helpers used when quoting an order. Independent of inventory.
function roundToCents(amount) {
  return Math.round(amount * 100) / 100;
}

function applyTax(amount, taxRatePercent) {
  return roundToCents(amount * (1 + taxRatePercent / 100));
}

module.exports = { roundToCents, applyTax };
