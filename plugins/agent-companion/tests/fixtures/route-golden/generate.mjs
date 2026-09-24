#!/usr/bin/env node
// Regenerate tests/fixtures/route-golden/expected.json from a PINNED git ref.
//
// expected.json is the FROZEN record of what the pre-ADR-0003 resolver
// returned on its own config. It is not the acceptance gate any more: the
// gate (live-gate.mjs, run by tests/route-golden.test.mjs) runs the vendored
// copy of that resolver under reference/ against the CURRENT config, so a
// routine table edit never calls for regenerating anything. This record only
// proves the vendored reference is faithful: the test checks reference/'s
// sha256 against the `source` block below and that it reproduces every row.
// There is no reason to regenerate it; if you must, pass the SAME baseline
// ref, never a ref carrying resolveRoute() (that would vet the reference
// against the code under test).
//
// This script extracts hooks/lib/context.mjs and config/model-tiers.json at
// <ref> with `git show` into a temp directory OUTSIDE the repository,
// evaluates cases.mjs against that copy's resolveExpected() in a hermetic
// child process (empty state root, so no per-machine model-tiers.json
// override leaks in), and writes the results.
//
// The old resolver has no clock parameter, so the child pins the calendar by
// replacing the global Date for each clock in CLOCKS.
//
// Usage (from anywhere inside the repo):
//   node plugins/agent-companion/tests/fixtures/route-golden/generate.mjs --ref <git-ref>
// The committed fixture was generated from the commit "docs(adr-0003): accept
// per-user routing profiles, decide open questions" (see its `source`
// block), before resolveRoute().

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'expected.json');
const PLUGIN_PATH = 'plugins/agent-companion';
const FILES = ['hooks/lib/context.mjs', 'config/model-tiers.json'];

const argv = process.argv.slice(2);
const refIdx = argv.indexOf('--ref');
const ref = refIdx >= 0 ? argv[refIdx + 1] : '';
if (!ref) {
  console.error('usage: generate.mjs --ref <the pinned baseline ref> (there is no default: the record is frozen)');
  process.exit(2);
}

function git(args) {
  const r = spawnSync('git', args, { cwd: HERE, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const commit = git(['rev-parse', `${ref}^{commit}`]).trim();
// The fixture records the commit by subject and date, not by hash: the
// repo's leak guard rejects any 7-40 char hex run in a committed file. The
// sha256 of each extracted file is the exact reproducibility anchor.
const [commitDate, commitSubject] = git(['log', '-1', '--format=%cI%n%s', commit]).trim().split(/\r?\n/);
const work = mkdtempSync(join(tmpdir(), 'ac-route-golden-'));
try {
  const baseline = join(work, 'baseline');
  const hashes = {};
  for (const rel of FILES) {
    const text = git(['show', `${commit}:${PLUGIN_PATH}/${rel}`]);
    const dest = join(baseline, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
    hashes[rel] = createHash('sha256').update(text).digest('hex');
  }

  const driver = join(work, 'driver.mjs');
  writeFileSync(driver, `
const RealDate = Date;
let fixed = null;
class PinnedDate extends RealDate {
  constructor(...a) { if (a.length === 0 && fixed !== null) super(fixed); else super(...a); }
  static now() { return fixed !== null ? fixed : RealDate.now(); }
}
globalThis.Date = PinnedDate;
const ctx = await import(${JSON.stringify(pathToFileURL(join(baseline, 'hooks/lib/context.mjs')).href)});
const { buildCases, CLOCKS } = await import(${JSON.stringify(pathToFileURL(join(HERE, 'cases.mjs')).href)});
const cfg = ctx.modelTiers();
const cases = buildCases({
  typeNames: Object.keys(cfg.taskTypes || {}),
  kinds: Object.keys(cfg.taskKinds || {}),
  consequences: Object.keys(cfg.consequence || {}),
});
const out = {};
for (const clock of CLOCKS) {
  fixed = RealDate.parse(clock);
  out[clock] = cases.map((c) => [c.key, ctx.resolveExpected(c.args)]);
}
fixed = null;
process.stdout.write(JSON.stringify({ clocks: CLOCKS, out }));
`);

  const home = join(work, 'home');
  const env = { ...process.env, AGENT_COMPANION_HOME_OVERRIDE: home, AGENT_COMPANION_STATE_DIR: join(home, '.claude', 'agent-companion') };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(process.execPath, [driver], { encoding: 'utf8', env, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`driver failed: ${r.stderr}`);
  const { clocks, out } = JSON.parse(r.stdout);

  // Deduplicate: most cases share one of a few hundred distinct answers.
  const results = [];
  const index = new Map();
  const idxOf = (v) => {
    const s = JSON.stringify(v);
    if (!index.has(s)) { index.set(s, results.length); results.push(v); }
    return index.get(s);
  };
  const cases = {};
  clocks.forEach((clock, ci) => {
    for (const [key, v] of out[clock]) {
      const bar = key.indexOf('|');
      const type = key.slice(0, bar);
      const rest = key.slice(bar + 1);
      cases[type] ??= {};
      cases[type][rest] ??= [];
      cases[type][rest][ci] = idxOf(v);
    }
  });

  const total = clocks.length * out[clocks[0]].length;
  // One entry per line keeps the diff reviewable when a baseline changes.
  const lines = [];
  lines.push('{');
  lines.push(`  "note": "GENERATED by tests/fixtures/route-golden/generate.mjs from the resolver at the pinned commit below. Do not edit by hand. cases[type][w|k|c] = one index into results per clock.",`);
  lines.push(`  "source": ${JSON.stringify({ ref, commitSubject, commitDate, sha256: hashes })},`);
  lines.push(`  "clocks": ${JSON.stringify(clocks)},`);
  lines.push(`  "caseCount": ${total},`);
  lines.push('  "results": [');
  results.forEach((v, i) => lines.push(`    ${JSON.stringify(v)}${i < results.length - 1 ? ',' : ''}`));
  lines.push('  ],');
  lines.push('  "cases": {');
  const typeKeys = Object.keys(cases);
  typeKeys.forEach((type, ti) => {
    lines.push(`    ${JSON.stringify(type)}: {`);
    const ks = Object.keys(cases[type]);
    ks.forEach((k, i) => lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(cases[type][k])}${i < ks.length - 1 ? ',' : ''}`));
    lines.push(`    }${ti < typeKeys.length - 1 ? ',' : ''}`);
  });
  lines.push('  }');
  lines.push('}');
  writeFileSync(OUT, lines.join('\n') + '\n');
  // Parse it back: a malformed fixture must fail here, not in the test.
  JSON.parse(readFileSync(OUT, 'utf8'));
  console.log(`wrote ${OUT}: ${out[clocks[0]].length} cases x ${clocks.length} clocks = ${total} evaluations, ${results.length} distinct results, from ${ref} (${commit.slice(0, 12)})`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}
