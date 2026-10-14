// Rung label helper, kept dependency-free so light modules (cohort, the register's metric path) can use it
// without loading config.mjs. A rung label is `model/effort` (the routing table and the spawn records write
// it that way, e.g. `sonnet/high`). `sonnet-high` is accepted as an alias and normalized to the slash form.
export function normalizeRung(v) {
  if (typeof v !== 'string' || v.includes('/')) return v;
  const m = /^([A-Za-z0-9._:-]+?)-(low|medium|high|xhigh|max)$/.exec(v);
  return m ? `${m[1]}/${m[2]}` : v;
}
