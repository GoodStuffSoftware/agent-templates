// Loaded first by hook-cost.mjs so the ESM loader's one-time start-up cost
// (paid by every hook's first file import, profile or not) is not billed to
// the routing-profile module.
export const noop = true;
