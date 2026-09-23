// Static detection pass: reads config + a few live facts, returns a list of
// signals { kind, detail } for anything worth surfacing to the operator.
import { MODEL_TIERS_CONFIG } from './model-tiers-config.mjs';

function sig(kind, detail) {
  return { kind, detail };
}

// { runningVersion, harnessReadable } -> signal[]
export function runDetection({ runningVersion, harnessReadable = true } = {}) {
  const signals = [];

  if (!harnessReadable) {
    signals.push(sig('harness_version_unreadable', 'could not determine the running harness version'));
    return signals;
  }

  // ... (other unrelated detection steps would normally go here) ...

  return signals;
}
