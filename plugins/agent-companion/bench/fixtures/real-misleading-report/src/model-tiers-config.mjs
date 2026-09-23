// Routing config for a model-alias table. `resolvesTo` says which concrete
// model each short alias currently resolves to on a harness at or above
// `minClaudeCodeVersion`; below that floor, the harness's own alias
// resolution is older and an alias can resolve to a different (typically
// older/cheaper) model than this table assumes.
export const MODEL_TIERS_CONFIG = {
  aliasResolution: {
    minClaudeCodeVersion: '2.1.280',
    note: 'aliases (e.g. `opus`) may still resolve to an OLDER model than the routing table claims on a harness below this version',
    resolvesTo: {
      opus: 'claude-opus-5-5',
      sonnet: 'claude-sonnet-5',
    },
  },
};
