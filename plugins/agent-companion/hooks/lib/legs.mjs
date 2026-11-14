// Two-leg routes (0.31.54): no Opus writers. A task type whose config row carries `legs` is split into a
// read-only PLAN leg and a WRITE leg (config/model-tiers.json `legsNote`). The row's own route (preset,
// trial or grid, floors included: resolveRoute) is the plan leg and stays on Opus; `legs.write` names the
// model and effort that writes. Data only: nothing here reads a brief or touches a spawn.

import { modelTiers } from './context.mjs';

// { plan: { label, artifact, what }, write: { model, effort } } for a type that has legs, else null.
export function legsOf(type, cfg = null) {
  try {
    const t = ((cfg || modelTiers()).taskTypes || {})[type];
    const l = t && t.legs;
    if (!l || !l.write || !l.write.model) return null;
    return {
      plan: {
        label: String(l.plan?.label || 'plan'),
        artifact: String(l.plan?.artifact || '<task>-plan.md'),
        what: String(l.plan?.what || ''),
      },
      write: { model: String(l.write.model), effort: l.write.effort ? String(l.write.effort) : null },
    };
  } catch {
    return null;
  }
}

// The (model, effort) that WRITES this type: its write leg, or null when the type has no legs (its route writes).
export function writeLegPair(type, cfg = null) {
  const l = legsOf(type, cfg);
  return l ? { model: l.write.model, effort: l.write.effort } : null;
}
