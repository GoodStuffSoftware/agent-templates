import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeFixture, PLUGIN_ROOT, REAL_CLAUDE_DIRS } from './helpers.mjs';

// A full `audit.mjs` run (every check, no --only filter) must never read from,
// write to, or print a path under the operator's REAL .claude tree, even though
// several checks (memory-index, memory-store-forks, memory-near-duplicates,
// instruction-budget) resolve a `.claude`-relative path internally. This guards
// the exact bug found in review: memory-index.mjs's memoryRoot() used raw
// homedir() instead of claudeDir(), so ctx.memoryDir (built unconditionally by
// audit.mjs on every run) silently read the operator's real ~/.claude/projects
// tree.
//
// TWO DEFECTS IN THE ORIGINAL DETECTOR, FIXED HERE — do not reintroduce either:
//
//   1. It scanned for the bare `homedir()` string, not for `<home>/.claude`.
//      On GitHub Actions $HOME=/home/runner and the checkout is
//      /home/runner/work/<repo>/<repo>, so the audit's own `target` path begins
//      with the home string and the assertion could not do anything but fire.
//      The property being guarded is "nothing under the operator's .claude
//      dir", not "nothing under $HOME" — a workspace that legitimately lives
//      under $HOME must not trip it. REAL_CLAUDE_DIRS (helpers.mjs) is the same
//      pair of roots context.mjs's claudeDir() can resolve to.
//
//   2. It scanned the RAW JSON TEXT, in which JSON.stringify has already
//      doubled every Windows backslash. `C:\Users\me` is emitted as
//      `C:\\Users\\me`, which the old normaliser turned into `C://Users//me` —
//      never containing `C:/Users/me`. The detector was therefore INERT on
//      Windows and would have missed a genuine leak. ALWAYS JSON.parse first
//      and walk the parsed string values; never substring-scan the serialized
//      text.
//
// The assertions below report JSON POINTERS ONLY (`$.results[3].data.dir`),
// never the offending value: this test must not print a real path, or real
// memory content, into its own report.
//
// The last two cases are the SENSITIVITY CONTROL. A guard on a security
// boundary that silently stops detecting is worse than no guard, because
// nothing surfaces that fact — which is precisely what happened here. Case 3
// deliberately defeats the isolation and asserts the detector DOES fire; case 4
// asserts the scanner still sees a JSON-escaped Windows path.

const TARGET = resolve(PLUGIN_ROOT);
const AUDIT = join(PLUGIN_ROOT, 'scripts', 'audit.mjs');
const CONTEXT_URL = pathToFileURL(join(PLUGIN_ROOT, 'hooks', 'lib', 'context.mjs')).href;
const AUDIT_TIMEOUT = 120000;

// --- the detector ---------------------------------------------------------

// Normalise separators before comparing — Windows paths appear with either
// slash style depending on which function built them — and fold case on
// Windows, where the same directory can be spelled either way.
const canon = (s) => {
  const n = String(s).replace(/\\/g, '/');
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

// True when `root` occurs in `value` as a directory in its own right. The
// boundary check keeps a sibling such as `<home>/.claude-backup` from counting
// while still catching `<home>/.claude`, `<home>/.claude/projects/...` and
// `<home>/.claude.json` (which IS the operator's config).
function occursUnder(value, root) {
  const n = canon(value);
  const r = canon(root);
  if (!r) return false;
  for (let i = n.indexOf(r); i !== -1; i = n.indexOf(r, i + 1)) {
    const next = n[i + r.length];
    if (next === undefined || !/[A-Za-z0-9_-]/.test(next)) return true;
  }
  return false;
}

// Walk every string value of a PARSED report and return the hits as
// { pointer, value }. Callers that might print a failure use `pointer` only.
function scanReport(report, roots) {
  const hits = [];
  const walk = (node, pointer) => {
    if (typeof node === 'string') {
      if (roots.some((r) => occursUnder(node, r))) hits.push({ pointer, value: node });
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${pointer}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, `${pointer}.${k}`);
    }
  };
  walk(report, '$');
  return hits;
}

const pointers = (hits) => hits.map((h) => h.pointer).join(', ');

// --- child-process plumbing -----------------------------------------------

// Ask the plugin's OWN resolver, in a child with exactly the env the audit will
// get, where it thinks home and .claude are. Used as a preflight so a case can
// prove its isolation before it runs anything that would act on it.
function resolveInChild(env) {
  const code = `import {homeRoot,claudeDir} from ${JSON.stringify(CONTEXT_URL)};`
    + 'process.stdout.write(JSON.stringify([homeRoot(),claudeDir()]));';
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  const [home, claude] = JSON.parse(out);
  return { home, claude };
}

// stdio is piped, never inherited: a leak that DID happen must not be echoed
// into this test's own report by way of the child's stderr.
function runAudit(env) {
  let out;
  try {
    out = execFileSync(process.execPath, [AUDIT, '--dir', PLUGIN_ROOT, '--json'], {
      encoding: 'utf8',
      cwd: PLUGIN_ROOT,
      env,
      timeout: AUDIT_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const firstErrLine = String(e.stderr || '').split('\n')[0];
    assert.fail(`audit.mjs did not complete (status ${e.status ?? 'n/a'}): ${firstErrLine}`);
  }
  const report = JSON.parse(out);
  // A silently-empty or broken audit must not pass by running no checks at all.
  assert.ok(Array.isArray(report.results) && report.results.length > 5, 'expected a full multi-check audit report');
  return report;
}

// --- the sentinel home ----------------------------------------------------

// A fresh temp dir that the child will see as its home (os.homedir() reads HOME
// on POSIX and USERPROFILE on Windows, so both are set). It is planted with a
// DECOY .claude memory tree: bait. Correct code resolves through the
// AGENT_COMPANION_* overrides and never finds it; a regression to raw homedir()
// reads the decoy and prints its path, which is detectable ANYWHERE — unlike
// the real home, whose contents vary by machine and are absent on CI.
function plantSentinelHome() {
  const sentinel = mkdtempSync(join(tmpdir(), 'ac-sentinel-'));
  // Same encoding audit.mjs/checks.mjs use for a project's memory directory.
  const enc = TARGET.replace(/[:\\/]/g, '-');
  const memory = join(sentinel, '.claude', 'projects', enc, 'memory');
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, 'MEMORY.md'), '# decoy index\n\n- [decoy](ac-decoy.md) - bait, never read\n');
  writeFileSync(join(memory, 'ac-decoy.md'), '---\ntitle: decoy\n---\nbait\n');
  // An unindexed file, so a check that DOES read the decoy also reports a
  // finding rather than a silent pass.
  writeFileSync(join(memory, 'ac-decoy-orphan.md'), '---\ntitle: decoy orphan\n---\nbait\n');
  return { sentinel, claudeDir: join(sentinel, '.claude'), memory };
}

// name + size + content digest for every entry, so ANY write, rewrite or
// deletion under the sentinel shows up — not just a new top-level file.
function inventory(dir) {
  const entries = [];
  const walk = (d, rel, depth) => {
    if (depth > 8) return;
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { entries.push(`${r}/`); walk(p, r, depth + 1); }
      else entries.push(`${r} ${statSync(p).size} ${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)}`);
    }
  };
  walk(dir, '', 0);
  return entries;
}

const names = (inv) => inv.map((e) => e.split(' ')[0]);

// --- 1. the real boundary --------------------------------------------------

test('audit.mjs --json (all checks) prints no path under the real ~/.claude', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const report = runAudit({
      ...process.env,
      CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
    });
    const hits = scanReport(report, REAL_CLAUDE_DIRS);
    assert.equal(
      hits.length, 0,
      `audit.mjs output must not contain a path under the operator's real .claude dir `
      + `(values withheld on purpose; ${hits.length} hit(s) at: ${pointers(hits)})`,
    );
  } finally {
    cleanup();
  }
});

// --- 2. the decoy tripwire -------------------------------------------------

test('audit.mjs --json neither reads nor writes a decoy home planted at HOME/USERPROFILE', () => {
  const { dir, cleanup } = makeFixture();
  const { sentinel, claudeDir } = plantSentinelHome();
  const planted = inventory(sentinel);
  try {
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
      HOME: sentinel,
      USERPROFILE: sentinel,
    };

    // Preflight: the overrides must still win over the sentinel home, or this
    // case would be asserting nothing.
    const resolved = resolveInChild(env);
    assert.equal(resolved.home, dir, 'fixture override must win over HOME/USERPROFILE');
    assert.equal(resolved.claude, join(dir, '.claude'), 'claudeDir() must resolve under the fixture');

    const report = runAudit(env);

    // Read side: no path under the decoy .claude was resolved or printed.
    const decoyHits = scanReport(report, [claudeDir]);
    assert.equal(decoyHits.length, 0, `audit.mjs resolved a path under the decoy home at: ${pointers(decoyHits)}`);
    // And the real boundary still holds under this env too.
    const realHits = scanReport(report, REAL_CLAUDE_DIRS);
    assert.equal(realHits.length, 0, `real .claude path in output at: ${pointers(realHits)}`);

    // Write side: catches a touch that prints nothing at all.
    const after = inventory(sentinel);
    const before = names(planted);
    const added = names(after).filter((n) => !before.includes(n));
    const removed = before.filter((n) => !names(after).includes(n));
    const changed = after.filter((e) => !planted.includes(e) && !added.includes(e.split(' ')[0]));
    assert.deepEqual(added, [], `audit.mjs wrote into the home directory: ${added.join(', ')}`);
    assert.deepEqual(removed, [], `audit.mjs deleted from the home directory: ${removed.join(', ')}`);
    assert.deepEqual(changed.map((e) => e.split(' ')[0]), [], 'audit.mjs modified a file in the home directory');
  } finally {
    rmSync(sentinel, { recursive: true, force: true, maxRetries: 3 });
    cleanup();
  }
});

// --- 3. SENSITIVITY CONTROL: the tripwire must fire when isolation is gone ---

test('SENSITIVITY CONTROL: defeating the isolation makes the detector fire', () => {
  const { sentinel, claudeDir, memory } = plantSentinelHome();
  const planted = inventory(sentinel);
  try {
    // Every isolation override removed — this is what a resolver bug looks
    // like from the outside. HOME/USERPROFILE still point at the sentinel, so
    // the run lands in the decoy instead of the operator's real tree.
    const env = { ...process.env, HOME: sentinel, USERPROFILE: sentinel };
    for (const k of ['AGENT_COMPANION_HOME_OVERRIDE', 'AGENT_COMPANION_STATE_DIR', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_CONFIG_DIR']) {
      delete env[k];
    }

    // SAFETY GATE, and it runs BEFORE anything is executed against this env:
    // prove the unisolated child resolves into the sentinel. If it does not,
    // fail here rather than let a deliberately-unisolated audit loose on the
    // operator's real ~/.claude.
    const resolved = resolveInChild(env);
    assert.equal(resolved.home, sentinel, 'control refuses to run: home did not resolve to the sentinel');
    assert.equal(resolved.claude, claudeDir, 'control refuses to run: claudeDir() did not resolve into the sentinel');

    const report = runAudit(env);

    // Read side MUST fire, and on the decoy memory dir specifically.
    const decoyHits = scanReport(report, [claudeDir]);
    assert.ok(decoyHits.length > 0, 'DETECTOR IS INERT: an unisolated audit produced no path under the home .claude dir');
    assert.ok(
      decoyHits.some((h) => occursUnder(h.value, memory)),
      `DETECTOR IS INERT: the decoy memory dir was read but not detected (hits at: ${pointers(decoyHits)})`,
    );

    // Write side MUST fire too — both halves of case 2 are live.
    const added = names(inventory(sentinel)).filter((n) => !names(planted).includes(n));
    assert.ok(added.length > 0, 'DETECTOR IS INERT: an unisolated audit wrote nothing into the home directory');

    // And the control itself stayed off the real boundary.
    const realHits = scanReport(report, REAL_CLAUDE_DIRS);
    assert.equal(realHits.length, 0, `control leaked a real .claude path at: ${pointers(realHits)}`);
  } finally {
    rmSync(sentinel, { recursive: true, force: true, maxRetries: 3 });
  }
});

// --- 4. SENSITIVITY CONTROL: the scanner must survive JSON escaping ---------

test('SENSITIVITY CONTROL: the scanner sees a JSON-escaped Windows path', () => {
  const root = REAL_CLAUDE_DIRS[0];
  const winRoot = root.replace(/\//g, '\\');
  // Round-tripped through JSON exactly as audit.mjs --json emits it: this is
  // the escaping that made the old raw-text scan inert on Windows.
  const report = JSON.parse(JSON.stringify({
    target: `${winRoot}\\projects\\some-project\\memory`,
    results: [
      { id: 'a', data: { dir: `${root}/projects/some-project/memory` } },
      { id: 'b', findings: [`read the index at ${winRoot}\\projects\\p\\memory\\MEMORY.md (bad)`] },
    ],
  }));

  const hits = scanReport(report, REAL_CLAUDE_DIRS);
  assert.deepEqual(
    hits.map((h) => h.pointer).sort(),
    ['$.results[0].data.dir', '$.results[1].findings[0]', '$.target'],
    'the scanner must catch a real .claude path in backslash, forward-slash and embedded form',
  );

  // ...and must not fire on a sibling directory that merely starts the same.
  const sibling = JSON.parse(JSON.stringify({ target: `${winRoot}-backup\\notes.md` }));
  assert.equal(scanReport(sibling, REAL_CLAUDE_DIRS).length, 0, 'a sibling like .claude-backup is not a leak');
});
