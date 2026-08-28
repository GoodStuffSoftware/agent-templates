// agent-companion audit runner.
//
// Runs a selectable, chainable set of checks against a directory / project /
// repo. The runner knows nothing about any individual check — it only knows the
// contract in checks.mjs — so adding a check (or a whole new vendor's worth of
// checks) never touches this file.
//
// Usage:
//   node audit.mjs                          # all checks, current directory
//   node audit.mjs --dir <path>             # audit another project
//   node audit.mjs --list                   # show available checks and exit
//   node audit.mjs --only memory-index,agent-defs
//   node audit.mjs --skip guard-canary
//   node audit.mjs --vendor anthropic       # filter by ecosystem
//   node audit.mjs --fix                    # apply repairs where a check supports it
//   node audit.mjs --json                   # machine-readable, for the scout
//   node audit.mjs --strict                 # exit 1 if anything FAILs
//
// Exit codes: 0 normally; 1 only with --strict and at least one failure. An
// audit that cannot run a check reports 'skip' and never pretends it passed.

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { CHECKS, memoryDirFor } from './checks.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const list = (n) => (val(n) || '').split(',').map((s) => s.trim()).filter(Boolean);

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(val('--dir') || process.cwd());
const dataDir = process.env.CLAUDE_PLUGIN_DATA
  || join(homedir(), '.claude', 'plugins', 'data', 'agent-companion');
try { mkdirSync(dataDir, { recursive: true }); } catch { /* non-fatal */ }

if (has('--list')) {
  console.log('Available checks:\n');
  for (const c of CHECKS) {
    console.log(`  ${c.id.padEnd(20)} [${(c.vendor || '*').padEnd(9)}] ${c.title}${c.fixable ? '  (fixable)' : ''}`);
  }
  console.log('\nChain them:  --only a,b   --skip c   --vendor anthropic   --fix');
  process.exit(0);
}

const only = list('--only');
const skip = list('--skip');
const vendor = val('--vendor');

const selected = CHECKS.filter((c) => {
  if (only.length && !only.includes(c.id)) return false;
  if (skip.includes(c.id)) return false;
  if (vendor && (c.vendor || '*') !== '*' && c.vendor !== vendor) return false;
  return true;
});

const unknown = only.filter((id) => !CHECKS.some((c) => c.id === id));
if (unknown.length) {
  console.error(`audit: unknown check(s): ${unknown.join(', ')}  (see --list)`);
  process.exit(2);
}

const ctx = {
  target,
  pluginRoot,
  dataDir,
  memoryDir: memoryDirFor(target),
  fix: has('--fix'),
};

const results = [];
for (const check of selected) {
  let r;
  try {
    r = check.run(ctx);
  } catch (e) {
    // A check that throws is reported as an error, never silently skipped —
    // a swallowed exception is indistinguishable from a clean result.
    r = { status: 'error', findings: [`check threw: ${e.message}`] };
  }
  let fixed = null;
  if (ctx.fix && check.fix && (r.status === 'fail' || r.status === 'warn')) {
    try {
      fixed = check.fix(ctx, r);
      const after = check.run(ctx);
      r = { ...after, findingsBeforeFix: r.findings };
    } catch (e) {
      fixed = [`fix threw: ${e.message}`];
    }
  }
  results.push({ id: check.id, title: check.title, vendor: check.vendor || '*', ...r, fixed });
}

const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
const failed = results.filter((r) => r.status === 'fail' || r.status === 'error');

if (has('--json')) {
  console.log(JSON.stringify({ target, vendor: vendor || 'all', counts, results }, null, 2));
} else {
  const mark = { ok: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP', error: 'ERR ' };
  console.log(`agent-companion audit — ${target}`);
  if (ctx.memoryDir) console.log(`memory: ${ctx.memoryDir}`);
  console.log('');
  for (const r of results) {
    console.log(`[${mark[r.status] || r.status}] ${r.title}  (${r.id})`);
    for (const f of r.findings || []) console.log(`         ${f}`);
    if (r.fixed?.length) {
      console.log(`         FIXED: ${r.fixed.length} change(s)`);
      for (const f of r.fixed.slice(0, 8)) console.log(`           - ${f}`);
      if (r.fixed.length > 8) console.log(`           ... and ${r.fixed.length - 8} more`);
    }
    console.log('');
  }
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
  console.log(`summary: ${summary || 'nothing ran'}`);
  const fixables = results.filter((r) => (r.status === 'fail' || r.status === 'warn')
    && CHECKS.find((c) => c.id === r.id)?.fixable);
  if (!ctx.fix && fixables.length) {
    console.log(`re-run with --fix to repair: ${fixables.map((r) => r.id).join(', ')}`);
    console.log('(repairs move and re-link; nothing is ever deleted)');
  }
}

process.exit(has('--strict') && failed.length ? 1 : 0);
