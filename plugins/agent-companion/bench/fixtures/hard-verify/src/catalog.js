// Small in-memory item catalog.
const { isValidSku } = require('./validate');

const CATALOG = {
  'ABC-1234': { name: 'Widget', priceCents: 1999 },
  'XYZ-5678': { name: 'Gadget', priceCents: 4999 },
};

function lookupItem(sku) {
  return CATALOG[sku] || null;
}

function isKnownSku(sku) {
  return isValidSku(sku) && CATALOG[sku] !== undefined;
}

module.exports = { lookupItem, isKnownSku, CATALOG };
