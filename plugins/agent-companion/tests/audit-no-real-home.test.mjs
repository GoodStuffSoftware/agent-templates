import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, delimiter } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeFixture, PLUGIN_ROOT, REAL_CLAUDE_DIRS } from './helpers.mjs';

// A full `audit.mjs` run (every check, no --only filter) must never read from,
// write to, or print a path under the operator's REAL .claude tree, even though
// several checks (memory-index, memory-index-ceiling, memory-store-forks,
// memory-near-duplicates, instruction-budget) resolve a `.claude`-relative path
// internally. This guards the exact bug found in review: memory-index.mjs's
// memoryRoot() used raw homedir() instead of claudeDir(), so ctx.memoryDir
// (built unconditionally by audit.mjs on every run) silently read the
// operator's real ~/.claude/projects tree.
//
// THREE DETECTORS, deliberately independent. A boundary guard that can only
// see one kind of evidence goes inert the moment a leak takes another shape —
// which is how the first two versions of this file failed.
//
//   (1) FS-ACCESS TRIPWIRE — the primary one. tests/fs-trace-preload.mjs is
//       loaded into the audit child via NODE_OPTIONS and records every
//       node:fs read whose resolved path lands under a watched root. This is
//       the only detector that catches the sites the original bug actually
//       lived in, because neither of them emits a usable string:
//       memory-index-ceiling reports `f.project`, the ENCODED directory name
//       (: \ / already replaced by -, so no `.claude` substring survives), and
//       instruction-budget reports only a label. Neither writes, either.
//       existsSync counts as an access: probing a path that does not exist
//       still proves the resolver aimed at the forbidden tree, so this works on
//       a machine — or a CI runner — with no such file at all.
//
//   (2) OUTPUT SCAN — for a path that does reach the report. It JSON.parses
//       first and walks the parsed string values (and keys). It must never
//       substring-scan the serialized text: JSON.stringify doubles every
//       Windows backslash, so `C:\Users\me` is emitted as `C:\\Users\\me`,
//       which a naive normaliser turns into `C://Users//me` — that is what made
//       an earlier version of this detector INERT on Windows.
//       It scans for <home>/.claude, not for $HOME: on GitHub Actions the
//       checkout lives under $HOME, and a workspace that legitimately sits
//       there must not trip the guard.
//
//   (3) DECOY MARKERS + WRITE INVENTORY — the decoy home is planted with a
//       distinctively named project directory and an oversized global
//       CLAUDE.md, so a leak that emits only an encoded name or only a label
//       still shows up, and any write/rewrite/deletion is caught by inventory.
//
// Every one of those three is asserted ABSENT in cases 1 and 2 and asserted
// PRESENT in case 3, so no layer can quietly stop detecting: if a check renames
// a label or stops emitting a name, case 3 goes red and says so.
//
// The output-scan assertions report JSON POINTERS ONLY, never the offending
// value: this test must not print a real path, or real memory content, into its
// own report.

const TARGET = resolve(PLUGIN_ROOT);
const AUDIT = join(PLUGIN_ROOT, 'scripts', 'audit.mjs');
const CONTEXT_URL = pathToFileURL(join(PLUGIN_ROOT, 'hooks', 'lib', 'context.mjs')).href;
const TRACER_URL = pathToFileURL(join(PLUGIN_ROOT, 'tests', 'fs-trace-preload.mjs')).href;
const AUDIT_TIMEOUT = 300000;

// --- the output scanner ----------------------------------------------------

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

// Every string in a PARSED report, as { pointer, value }. Object KEYS are
// included: nothing emits a path-shaped key today, but a scanner that only
// walks values would not notice if one started to.
function reportStrings(report) {
  const out = [];
  const walk = (node, pointer) => {
    if (typeof node === 'string') out.push({ pointer, value: node });
    else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${pointer}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        out.push({ pointer: `${pointer}.${k}<key>`, value: k });
        walk(v, `${pointer}.${k}`);
      }
    }
  };
  walk(report, '$');
  return out;
}

const pathHits = (report, roots) => reportStrings(report).filter((s) => roots.some((r) => occursUnder(s.value, r)));
const markerHits = (report, marker) => reportStrings(report).filter((s) => s.value.includes(marker));
const pointers = (hits) => hits.map((h) => h.pointer).join(', ');

// --- keeping a third-party CLI out of the measurement ----------------------

// checks.mjs shells out to `claude --version` and `claude plugin validate`. The
// real CLI initialises whatever HOME/USERPROFILE it is handed, writing
// .claude.json and .claude/backups/ into it — so on a machine where the CLI is
// installed, that first-run side effect lands in the sentinel and case 2 blames
// audit.mjs for it. CI never installs the CLI, so the failure is invisible there
// and shows up only on the operator's own platform. Shadowing `claude` with a
// stub that always fails makes every machine behave like CI: the two checks
// degrade to skip/fail exactly as they do in the pipeline, and every other check
// still runs. This is NOT a whitelist — the write assertion stays absolute.
function makeClaudeStubDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-noclaude-'));
  if (process.platform === 'win32') {
    // cmd.exe tries every PATHEXT extension in THIS directory before moving to
    // the next one, so a .cmd/.bat here shadows a real claude.exe later in PATH.
    writeFileSync(join(dir, 'claude.cmd'), '@echo off\r\nexit /b 127\r\n');
    writeFileSync(join(dir, 'claude.bat'), '@echo off\r\nexit /b 127\r\n');
  } else {
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  }
  return dir;
}

const CLAUDE_STUB_DIR = makeClaudeStubDir();
after(() => { try { rmSync(CLAUDE_STUB_DIR, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });

// Windows env vars are case-insensitive but a spread object is not, so setting
// `PATH` next to an inherited `Path` would hand the child both.
function withPath(env, value) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== 'path') out[k] = v;
  out[process.platform === 'win32' ? 'Path' : 'PATH'] = value;
  return out;
}

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

// Run the audit with the FS tripwire armed. Returns the parsed report plus the
// trace. stdio is piped, never inherited: a leak that DID happen must not be
// echoed into this test's own report by way of the child's stderr.
function runAuditTraced(baseEnv, watchRoots) {
  const logDir = mkdtempSync(join(tmpdir(), 'ac-fstrace-'));
  const log = join(logDir, 'trace.log');
  writeFileSync(log, '');
  try {
    const env = withPath({
      ...baseEnv,
      AC_FS_TRACE_LOG: log,
      AC_FS_TRACE_ROOTS: JSON.stringify(watchRoots),
      NODE_OPTIONS: `--import ${JSON.stringify(TRACER_URL)}`,
    }, `${CLAUDE_STUB_DIR}${delimiter}${baseEnv.PATH || baseEnv.Path || ''}`);

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
      assert.fail(`audit.mjs did not complete (status ${e.status ?? 'n/a'}): ${String(e.stderr || '').split('\n')[0]}`);
    }

    const report = JSON.parse(out);
    // A silently-empty or broken audit must not pass by running no checks.
    assert.ok(Array.isArray(report.results) && report.results.length > 5, 'expected a full multi-check audit report');

    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
    const armed = lines.filter((l) => l[0] === 'ARMED').length;
    const fsHits = lines.filter((l) => l[0] === 'HIT').map((l) => ({ fn: l[2], path: l[3] }));
    // If the preload silently failed to load, every fs assertion below would
    // pass vacuously. Refuse to let that look like a clean run.
    assert.ok(armed > 0, 'FS TRIPWIRE DID NOT ARM: the audit child never loaded the tracer, so its fs access is unmeasured');
    return { report, armed, fsHits };
  } finally {
    rmSync(logDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// --- the sentinel home ----------------------------------------------------

// A fresh temp dir that the child will see as its home (os.homedir() reads HOME
// on POSIX and USERPROFILE on Windows, so both are set), planted with a DECOY
// .claude tree: bait. Correct code resolves through the AGENT_COMPANION_*
// overrides and never finds it; a bad resolver reads it, and each piece of bait
// is shaped to surface through a different check.
function plantSentinelHome() {
  const sentinel = mkdtempSync(join(tmpdir(), 'ac-sentinel-'));
  const claudeDir = join(sentinel, '.claude');

  // Bait 1 — memoryDirFor(): the project directory name audit.mjs encodes for
  // THIS target, so ctx.memoryDir resolves and memory-index reports its path.
  const enc = TARGET.replace(/[:\\/]/g, '-');
  const memory = join(claudeDir, 'projects', enc, 'memory');
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, 'MEMORY.md'), '# decoy index\n\n- [decoy](ac-decoy.md) - bait, never read\n');
  writeFileSync(join(memory, 'ac-decoy.md'), '---\ntitle: decoy\n---\nbait\n');
  // Unindexed, so a check that DOES read the decoy reports a finding rather
  // than passing silently.
  writeFileSync(join(memory, 'ac-decoy-orphan.md'), '---\ntitle: decoy orphan\n---\nbait\n');

  // Bait 2 — memoryRoot(): a second project whose NAME is unmistakable.
  // memory-index-ceiling emits `f.project`, an encoded directory name with no
  // `.claude` substring in it, so a path scan cannot see that leak but this can.
  // The random suffix means the marker cannot be computed from anything except
  // a real directory listing of the decoy.
  const decoyProject = `ac-decoy-project-${randomBytes(6).toString('hex')}`;
  const decoyProjectMem = join(claudeDir, 'projects', decoyProject, 'memory');
  mkdirSync(decoyProjectMem, { recursive: true });
  writeFileSync(join(decoyProjectMem, 'MEMORY.md'), `# decoy corpus ${decoyProject}\n\n- [x](x.md) - bait\n`);
  writeFileSync(join(decoyProjectMem, 'x.md'), '---\ntitle: x\n---\nbait\n');

  // Bait 3 — instruction-budget's global CLAUDE.md, which is reported as a
  // bare label with no path at all. Oversized so reading it must produce a
  // finding rather than a silent pass.
  writeFileSync(join(claudeDir, 'CLAUDE.md'), `# decoy global\n${'- decoy line\n'.repeat(260)}`);

  return { sentinel, claudeDir, memory, decoyProject };
}

// A { name -> signature } map over every entry, so ANY write, rewrite or
// deletion under the sentinel shows up — not just a new top-level file. Kept as
// a map rather than formatted strings because a home path may contain spaces.
function inventory(dir) {
  const entries = new Map();
  const walk = (d, rel, depth) => {
    if (depth > 8) return;
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { entries.set(`${r}/`, 'dir'); walk(p, r, depth + 1); }
      else entries.set(r, `${statSync(p).size}:${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)}`);
    }
  };
  walk(dir, '', 0);
  return entries;
}

// What changed between two inventories, as three sorted name lists.
function inventoryDelta(before, after_) {
  const added = [...after_.keys()].filter((n) => !before.has(n)).sort();
  const removed = [...before.keys()].filter((n) => !after_.has(n)).sort();
  const changed = [...after_.keys()].filter((n) => before.has(n) && before.get(n) !== after_.get(n)).sort();
  return { added, removed, changed };
}

// instruction-budget's label for the global CLAUDE.md. Asserted absent in cases
// 1 and 2 and PRESENT in case 3, so a rename cannot make it quietly stop
// detecting.
const GLOBAL_CLAUDE_MD_LABEL = 'global CLAUDE.md';

// --- 1. the real boundary --------------------------------------------------

test('audit.mjs --json (all checks) never touches the real ~/.claude', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { report, fsHits } = runAuditTraced({
      ...process.env,
      CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
    }, REAL_CLAUDE_DIRS);

    // (1) fs tripwire — the detector that sees a read emitting nothing.
    assert.deepEqual(
      fsHits.map((h) => h.fn), [],
      `audit.mjs made ${fsHits.length} filesystem access(es) under the operator's real .claude dir`
      + ` (paths withheld on purpose; entry points: ${[...new Set(fsHits.map((h) => h.fn))].join(', ')})`,
    );

    // (2) output scan.
    const hits = pathHits(report, REAL_CLAUDE_DIRS);
    assert.equal(hits.length, 0, `real .claude path in the report (values withheld) at: ${pointers(hits)}`);

    // (3) the label instruction-budget emits for a global CLAUDE.md it read.
    const budget = markerHits(report, GLOBAL_CLAUDE_MD_LABEL);
    assert.equal(budget.length, 0, `instruction-budget read a global CLAUDE.md at: ${pointers(budget)}`);
  } finally {
    cleanup();
  }
});

// --- 2. the decoy tripwire -------------------------------------------------

test('audit.mjs --json neither reads nor writes a decoy home planted at HOME/USERPROFILE', () => {
  const { dir, cleanup } = makeFixture();
  const { sentinel, claudeDir, decoyProject } = plantSentinelHome();
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

    const { report, fsHits } = runAuditTraced(env, [...REAL_CLAUDE_DIRS, claudeDir]);

    // (1) fs tripwire: no access under the decoy .claude OR the real one.
    assert.deepEqual(
      fsHits.map((h) => h.fn), [],
      `audit.mjs made ${fsHits.length} filesystem access(es) under a home .claude dir`
      + ` (entry points: ${[...new Set(fsHits.map((h) => h.fn))].join(', ')})`,
    );

    // (2) output scan, decoy and real.
    const decoyHits = pathHits(report, [claudeDir]);
    assert.equal(decoyHits.length, 0, `audit.mjs resolved a path under the decoy home at: ${pointers(decoyHits)}`);
    const realHits = pathHits(report, REAL_CLAUDE_DIRS);
    assert.equal(realHits.length, 0, `real .claude path in output at: ${pointers(realHits)}`);

    // (3) markers: the encoded project name and the global-CLAUDE.md label,
    // neither of which is path-shaped.
    const nameHits = markerHits(report, decoyProject);
    assert.equal(nameHits.length, 0, `the decoy corpus was enumerated — its project name reached the report at: ${pointers(nameHits)}`);
    const budget = markerHits(report, GLOBAL_CLAUDE_MD_LABEL);
    assert.equal(budget.length, 0, `instruction-budget read the decoy global CLAUDE.md at: ${pointers(budget)}`);

    // Write side: catches a touch that prints nothing at all.
    const { added, removed, changed } = inventoryDelta(planted, inventory(sentinel));
    assert.deepEqual(added, [], `audit.mjs wrote into the home directory: ${added.join(', ')}`);
    assert.deepEqual(removed, [], `audit.mjs deleted from the home directory: ${removed.join(', ')}`);
    assert.deepEqual(changed, [], `audit.mjs modified a file in the home directory: ${changed.join(', ')}`);
  } finally {
    rmSync(sentinel, { recursive: true, force: true, maxRetries: 3 });
    cleanup();
  }
});

// --- 3. SENSITIVITY CONTROL: every detector must fire when isolation is gone --

test('SENSITIVITY CONTROL: defeating the isolation makes all three detectors fire', () => {
  const { sentinel, claudeDir, memory, decoyProject } = plantSentinelHome();
  const planted = inventory(sentinel);
  try {
    // Every isolation override removed — this is what a resolver bug looks like
    // from the outside. Identical to case 2 in every other respect, including
    // the claude-free PATH, so the overrides are the only variable.
    // HOME/USERPROFILE still point at the sentinel, so the run lands in the
    // decoy instead of the operator's real tree.
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

    const { report, fsHits } = runAuditTraced(env, [claudeDir]);

    // (1) FS tripwire must fire, and on the decoy memory dir specifically —
    // this is the detector the other two cases depend on entirely.
    assert.ok(fsHits.length > 0, 'FS TRIPWIRE IS INERT: an unisolated audit recorded no access under the home .claude dir');
    assert.ok(
      fsHits.some((h) => occursUnder(h.path, memory)),
      `FS TRIPWIRE IS INERT: the decoy memory dir was not among ${fsHits.length} recorded access(es)`,
    );

    // (2) output scan must fire.
    const decoyHits = pathHits(report, [claudeDir]);
    assert.ok(decoyHits.length > 0, 'OUTPUT SCAN IS INERT: an unisolated audit produced no path under the home .claude dir');

    // (3) both non-path markers must fire, so neither can quietly stop
    // detecting if a check renames a label or stops emitting a name.
    assert.ok(markerHits(report, decoyProject).length > 0, 'MARKER IS INERT: the decoy project name did not reach the report');
    assert.ok(markerHits(report, GLOBAL_CLAUDE_MD_LABEL).length > 0, `MARKER IS INERT: no "${GLOBAL_CLAUDE_MD_LABEL}" finding from the oversized decoy`);

    // Write side must fire too.
    const { added } = inventoryDelta(planted, inventory(sentinel));
    assert.ok(added.length > 0, 'INVENTORY IS INERT: an unisolated audit wrote nothing into the home directory');

    // And the control itself stayed off the real boundary.
    const realHits = pathHits(report, REAL_CLAUDE_DIRS);
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

  assert.deepEqual(
    pathHits(report, REAL_CLAUDE_DIRS).map((h) => h.pointer).sort(),
    ['$.results[0].data.dir', '$.results[1].findings[0]', '$.target'],
    'the scanner must catch a real .claude path in backslash, forward-slash and embedded form',
  );

  // A path-shaped KEY counts too.
  const keyed = JSON.parse(JSON.stringify({ sizes: { [`${winRoot}\\projects\\p\\MEMORY.md`]: 10 } }));
  assert.equal(pathHits(keyed, REAL_CLAUDE_DIRS).length, 1, 'the scanner must catch a real .claude path used as an object key');

  // ...and must not fire on a sibling directory that merely starts the same.
  const sibling = JSON.parse(JSON.stringify({ target: `${winRoot}-backup\\notes.md` }));
  assert.equal(pathHits(sibling, REAL_CLAUDE_DIRS).length, 0, 'a sibling like .claude-backup is not a leak');
});

// --- 5. the tripwire file itself must stay wired up ------------------------

test('the fs tracer exists and is not imported by any shipped plugin code', () => {
  assert.ok(existsSync(join(PLUGIN_ROOT, 'tests', 'fs-trace-preload.mjs')), 'fs-trace-preload.mjs is missing');
  for (const rel of [join('scripts', 'audit.mjs'), join('scripts', 'checks.mjs'), join('hooks', 'lib', 'context.mjs'), join('hooks', 'lib', 'memory-index.mjs')]) {
    const src = readFileSync(join(PLUGIN_ROOT, rel), 'utf8');
    assert.ok(!src.includes('fs-trace-preload'), `${rel} must not reference the test-only tracer`);
  }
});
