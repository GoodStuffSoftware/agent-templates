#!/usr/bin/env node
// Builds a new task pack: writes manifest.json + copies report.md and
// hidden-test.mjs into --out, then runs the SAME fail-at-parent/pass-at-fix/
// leak-guard verification `verify-pack.mjs` runs on an existing pack. See
// FORMAT.md for the manifest schema and what each check proves.
//
// Usage:
//   node build-pack.mjs --repo <path> --id <pack-id> \
//     --parent <ref> --fix <ref> --files a.mjs,b/c.mjs \
//     --report <path/to/report.md> --hidden-test <path/to/hidden-test.mjs> \
//     [--leak-phrases "phrase one,phrase two"] [--max-budget-usd 0.8] \
//     [--expected-files <extra,paths>] \
//     --out <pack-dir>
//
// Never stores --repo in the manifest -- the source repo path is always a
// RUNTIME parameter (scripts/benchmark.mjs's --pack-repo), never baked in.

import fs from 'node:fs';
import path from 'node:path';
import { loadPack, verifyPack, encodeRef } from './lib.mjs';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const repo = val('--repo');
const id = val('--id');
const parentRef = val('--parent');
const fixRef = val('--fix');
const filesArg = val('--files');
const reportPath = val('--report');
const hiddenTestPath = val('--hidden-test');
const outDir = val('--out');
const leakPhrasesArg = val('--leak-phrases');
const maxBudgetUsd = Number(val('--max-budget-usd') ?? '1.0');
const expectedFilesArg = val('--expected-files');

const missing = [];
for (const [name, v] of [['--repo', repo], ['--id', id], ['--parent', parentRef], ['--fix', fixRef], ['--files', filesArg], ['--report', reportPath], ['--hidden-test', hiddenTestPath], ['--out', outDir]]) {
  if (!v) missing.push(name);
}
if (missing.length) {
  console.error(`build-pack.mjs: missing required arg(s): ${missing.join(', ')}\nSee the file header for usage.`);
  process.exit(2);
}

const files = filesArg.split(',').map((s) => s.trim()).filter(Boolean);
const leakPhrases = leakPhrasesArg ? leakPhrasesArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
const expectedFiles = expectedFilesArg ? [...files, ...expectedFilesArg.split(',').map((s) => s.trim()).filter(Boolean)] : undefined;

fs.mkdirSync(outDir, { recursive: true });
const manifest = {
  id,
  // Base64, never plaintext -- a raw git SHA is exactly what this repo's
  // own leak-check.mjs bans (git-sha-like). See lib.mjs's loadPack() note.
  parentRefB64: encodeRef(parentRef),
  fixRefB64: encodeRef(fixRef),
  files, leakPhrases, maxBudgetUsd,
  ...(expectedFiles ? { expectedFiles } : {}),
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.copyFileSync(reportPath, path.join(outDir, 'report.md'));
fs.copyFileSync(hiddenTestPath, path.join(outDir, 'hidden-test.mjs'));

console.log(`Wrote ${outDir}/manifest.json, report.md, hidden-test.mjs.`);
console.log('Verifying: fail-at-parent, pass-at-fix, leak guard...\n');

const pack = loadPack(outDir);
const result = await verifyPack(pack, repo);
for (const line of result.detail) console.log('  ' + line);

if (!result.ok) {
  console.error(`\nFAILED verification for pack "${id}" — this pack is NOT usable yet. Fix the hidden test, the prompt, or the file list, then re-run this script or verify-pack.mjs.`);
  process.exit(1);
}
console.log(`\nOK — pack "${id}" verified: fails at parentRef, passes at fixRef, leak guard clean.`);
