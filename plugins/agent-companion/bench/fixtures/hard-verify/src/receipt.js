// Turns a processOrder() result into a human-readable receipt line.
// Not called from anywhere else in this package -- a caller (e.g. a CLI
// or an API layer) is expected to invoke this separately from processOrder.
const { formatPrice, formatSku } = require('./format');

function buildReceiptLine(order) {
  return `${formatSku(order.sku)} x${order.qty} @ ${formatPrice(order.unitPriceCents)} = ${formatPrice(order.totalCents)}`;
}

module.exports = { buildReceiptLine };
