#!/usr/bin/env node
// CLI entry point for the legacy-data import (see hooks/lib/state-sync.mjs).
// Safe to run any time, any number of times: locked, incremental, and never
// deletes or modifies a source file. Also runs automatically from
// scout-surface.mjs (SessionStart), detect.mjs and audit.mjs, so this CLI
// exists mainly for a manual check or a first migration on an operator's
// machine.
//
// Usage:
//   node scripts/state-sync.mjs           # human-readable summary
//   node scripts/state-sync.mjs --json    # machine-readable

import { syncLegacy } from '../hooks/lib/state-sync.mjs';

const json = process.argv.includes('--json');
const result = syncLegacy();

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.skipped) {
  console.log(`state-sync: skipped (${result.skipped})`);
} else {
  const parts = Object.entries(result.imported).map(([k, v]) => `${k}=${v}`);
  console.log(`state-sync: imported ${parts.length ? parts.join(', ') : 'nothing new'}`);
}
