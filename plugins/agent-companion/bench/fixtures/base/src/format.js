// Presentation helpers. No business logic here.

function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatSku(sku) {
  return sku.toUpperCase().trim();
}

module.exports = { formatPrice, formatSku };
