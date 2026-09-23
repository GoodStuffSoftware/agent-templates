#!/usr/bin/env node
// Re-verifies an existing task pack against a (possibly re-cloned) copy of
// its source repo -- fail-at-parent, pass-at-fix, leak guard. Run this after
// editing a pack's hidden-test.mjs or report.md, or periodically to confirm
// a pack still holds against the repo it was built from. See FORMAT.md.
//
// Usage: node verify-pack.mjs --pack <pack-dir> --repo <path>
// Exit code: 0 verified, 1 failed, 2 usage error.

import { loadPack, verifyPack } from './lib.mjs';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const packDir = val('--pack');
const repo = val('--repo');
if (!packDir || !repo) {
  console.error('usage: node verify-pack.mjs --pack <pack-dir> --repo <path>');
  process.exit(2);
}

const pack = loadPack(packDir);
console.log(`Verifying pack "${pack.id}" (${packDir}) against ${repo} ...\n`);
const result = await verifyPack(pack, repo);
for (const line of result.detail) console.log('  ' + line);

if (!result.ok) {
  console.error(`\nFAILED — parentPass=${result.parentPass} fixPass=${result.fixPass} leakOk=${result.leakOk} (want parentPass=false, fixPass=true, leakOk=true)`);
  process.exit(1);
}
console.log(`\nOK — "${pack.id}" verified.`);
