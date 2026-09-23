// Extracted decision logic from a larger spawn-time guard hook. Two pieces,
// both real, both reduced to pure functions of their inputs (the real hook
// reads config files and hook-payload context for these same facts; here
// they are passed in directly so the logic is independently testable).
//
// classifyModelAlias / modelTakesEffort are tiny local stand-ins for the
// real hook's model-lineup classifier -- narrow, but sufficient for this
// module: only the alias and whether a model takes an effort parameter at
// all matter to the two functions below.
export function classifyModelAlias(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  return model;
}

export function modelTakesEffort(model) {
  return !!model && classifyModelAlias(model) !== 'haiku';
}

// A spawn that resolves to opus with no effort stated ANYWHERE (agent
// definition frontmatter, or an EFFORT: line in the brief) silently gets
// Opus 5.5's MEDIUM default -- one level below Opus 5's old HIGH default --
// so an unstated effort now means less thinking than whoever wrote the
// brief likely assumed.
//
// { model, def, declaredEffort } -> note string | null
export function computeNoEffortNote({ model, def, declaredEffort }) {
  const opusResolved = classifyModelAlias(model) === 'opus';
  const opusEffortStated = !!(def?.effort || declaredEffort);
  return (opusResolved && !opusEffortStated)
    ? 'agent-companion: this spawn resolves to opus with no effort stated anywhere (agent definition frontmatter, '
      + 'or an EFFORT: line in the brief). Opus 5.5 defaults to MEDIUM effort -- one level below Opus 5\'s old HIGH '
      + 'default -- so an unstated effort now means less thinking than it used to. State it explicitly: add '
      + '"EFFORT: <low|medium|high|xhigh|max>" to the brief, or set `effort:` in the agent definition frontmatter.'
    : null;
}

// Minimal local stand-in for the real per-model routing config.
const MODEL_TIERS = {
  opus: { resolvesTo: { defaultEffort: 'medium' } },
  sonnet: { resolvesTo: { defaultEffort: 'medium' } },
};

// What effort will ACTUALLY run, for telemetry. Two cases: the agent
// definition names one explicitly, or it does not, in which case the
// harness applies the MODEL's own API default.
//
// { def, model, callerEffort } -> effort string | null
export function computeEffectiveEffort({ def, model, callerEffort }) {
  const noEffortModel = !modelTakesEffort(model);
  if (def?.effort) return def.effort;
  if (!noEffortModel && model) {
    const tierSpec = MODEL_TIERS[classifyModelAlias(model)] || {};
    const apiDefault = tierSpec.resolvesTo?.defaultEffort || null;
    return apiDefault ? `unset(model-default:${apiDefault})` : 'unset(model-default:unknown)';
  }
  return null;
}
