// Tests for scripts/recurrence.mjs and its wiring into scripts/detect.mjs's
// "recurring_failures" scout check.
//
// Covers, in order: the main-guard witness (per
// lessons/universal/a-cli-script-without-a-main-guard-runs-on-import.md —
// this file is imported directly by both this test file and detect.mjs, so
// a bare import must run nothing), Fix 1 (tool_result/toolUseResult only,
// never assistant/user prose), Fix 2 (prefix-variant collapsing without
// erasing the error class), Fix 3 (--since / mtime filtering), the
// min-sessions floor, the CLI (--json purity, human table, the write
// location), and detect.mjs's baseline-diffing "only what's NEW" behaviour.
//
// No test touches the real ~/.claude — every fixture uses makeFixture() and
// an explicit `root` (scanRecurrence tests) or AGENT_COMPANION_TRANSCRIPTS_ROOT
// (CLI / detect.mjs subprocess tests), same convention transcript-harvest's
// own tests and coverage.test.mjs already use.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';
import { scanRecurrence, signature } from '../scripts/recurrence.mjs';

function toolResultLine({ sessionId, cwd = '/home/x/proj', timestamp, text }) {
  return JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', content: text, is_error: true, tool_use_id: `t-${sessionId}` }] },
  });
}

function toolUseResultLine({ sessionId, cwd = '/home/x/proj', timestamp, stderr }) {
  return JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    timestamp,
    toolUseResult: { stdout: '', stderr, interrupted: false },
  });
}

function proseLine({ sessionId, cwd = '/home/x/proj', timestamp, text }) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    cwd,
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

// --- main-guard witness ---------------------------------------------------

test('recurrence.mjs: importing the module runs no CLI side effects', () => {
  const script = join(PLUGIN_ROOT, 'scripts', 'recurrence.mjs');
  const res = spawnSync(process.execPath, ['-e',
    `import(${JSON.stringify(pathToFileURL(script).href)})`
    + `.then(() => { process.stdout.write('IMPORTED_OK'); process.exit(0); })`
    + `.catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });`,
  ], { encoding: 'utf8', timeout: 15000 });
  assert.equal(res.status, 0, `import threw: ${res.stderr}`);
  assert.equal(res.stdout, 'IMPORTED_OK', `module produced output just from being imported: ${JSON.stringify(res.stdout)}`);
});

// --- Fix 1: tool_result / toolUseResult only -------------------------------

test('scanRecurrence: assistant/user prose never matches, even when failure-shaped', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'corpus');
    const proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });

    // The exact noise shape named in the ADR/brief: a standing-rule line
    // quoted into three briefs, never a real failure.
    const noise = "if the reviewer failed to catch it, update that agent's .md immediately";
    let prose = '';
    for (const sid of ['p1', 'p2', 'p3']) {
      prose += `${proseLine({ sessionId: sid, timestamp: '2026-09-01T00:00:00Z', text: noise })}\n`;
    }
    writeFileSync(join(proj, 'prose.jsonl'), prose);

    let tool = '';
    for (const sid of ['t1', 't2', 't3']) {
      tool += `${toolResultLine({ sessionId: sid, timestamp: '2026-09-02T00:00:00Z', text: "Error: ENOENT: no such file or directory, open '/a/b/c.tmp'" })}\n`;
    }
    writeFileSync(join(proj, 'tool.jsonl'), tool);

    const { ranked } = await scanRecurrence({ root, sinceMs: -Infinity, minSessions: 3 });

    assert.ok(!ranked.some((r) => r.sig.includes('failed to')), `prose noise leaked into the ranked output: ${JSON.stringify(ranked)}`);
    assert.equal(ranked.length, 1, `expected only the real tool-result failure: ${JSON.stringify(ranked)}`);
    assert.equal(ranked[0].sessions, 3);
  } finally {
    cleanup();
  }
});

test('scanRecurrence: top-level toolUseResult.stderr (object form) is eligible too', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'corpus');
    const proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    let lines = '';
    for (const sid of ['u1', 'u2', 'u3']) {
      lines += `${toolUseResultLine({ sessionId: sid, timestamp: '2026-09-02T00:00:00Z', stderr: 'fatal: not a valid object name: main' })}\n`;
    }
    writeFileSync(join(proj, 's.jsonl'), lines);

    const { ranked } = await scanRecurrence({ root, sinceMs: -Infinity, minSessions: 3 });
    assert.equal(ranked.length, 1, JSON.stringify(ranked));
    assert.equal(ranked[0].sessions, 3);
  } finally {
    cleanup();
  }
});

// --- Fix 2: prefix-variant collapsing --------------------------------------

test('signature(): collapses Error:/ENOENT:/bare prefix variants of one failure, keeps distinct error classes apart', () => {
  const p = "C:\\Users\\x\\AppData\\Local\\Temp\\foo.tmp";
  const a = signature(`Error: ENOENT: no such file or directory, open '${p}'`);
  const b = signature(`ENOENT: no such file or directory, open '${p}'`);
  const c = signature(`No such file or directory, open '${p}'`);
  assert.equal(a, b, `Error:+ENOENT: did not collapse to the same signature as ENOENT: alone`);
  assert.equal(b, c, `ENOENT: did not collapse to the same signature as the bare phrase`);

  const te = signature('TypeError: Cannot read properties of undefined');
  const se = signature('SyntaxError: Cannot read properties of undefined');
  assert.notEqual(te, se, 'stripping must not erase the error CLASS — these are genuinely different failures');
});

test('scanRecurrence: three prefix variants of one failure collapse into ONE ranked row', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'corpus');
    const proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    const p = '/home/x/proj/tmp/foo.tmp';
    let lines = '';
    lines += `${toolResultLine({ sessionId: 'v1', timestamp: '2026-09-01T00:00:00Z', text: `Error: ENOENT: no such file or directory, open '${p}'` })}\n`;
    lines += `${toolResultLine({ sessionId: 'v2', timestamp: '2026-09-02T00:00:00Z', text: `ENOENT: no such file or directory, open '${p}'` })}\n`;
    lines += `${toolResultLine({ sessionId: 'v3', timestamp: '2026-09-03T00:00:00Z', text: `No such file or directory, open '${p}'` })}\n`;
    writeFileSync(join(proj, 's.jsonl'), lines);

    const { ranked } = await scanRecurrence({ root, sinceMs: -Infinity, minSessions: 3 });
    assert.equal(ranked.length, 1, `expected the three variants to collapse to one row: ${JSON.stringify(ranked)}`);
    assert.equal(ranked[0].sessions, 3);
  } finally {
    cleanup();
  }
});

// --- Fix 3: incremental --since ---------------------------------------------

test('scanRecurrence: sinceMs skips a transcript whose mtime predates it', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'corpus');
    const proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });

    const oldFile = join(proj, 'old.jsonl');
    writeFileSync(oldFile, `${toolResultLine({ sessionId: 'o1', timestamp: '2020-01-01T00:00:00Z', text: 'fatal: reference is not a tree: old-branch-name' })}\n`);
    const oldStamp = new Date('2020-01-01T00:00:00Z');
    utimesSync(oldFile, oldStamp, oldStamp);

    const newFile = join(proj, 'new.jsonl');
    writeFileSync(newFile, `${toolResultLine({ sessionId: 'n1', timestamp: '2026-09-20T00:00:00Z', text: 'fatal: reference is not a tree: new-branch-name' })}\n`);
    // newFile's mtime is "now" (just written) — after the cutoff below.

    const cutoff = Date.parse('2025-01-01T00:00:00Z');
    const { ranked, meta } = await scanRecurrence({ root, sinceMs: cutoff, minSessions: 1 });

    assert.equal(meta.scope, 'incremental');
    assert.equal(meta.filesSkippedByMtime, 1, JSON.stringify(meta));
    assert.ok(ranked.some((r) => r.sig.includes('new-branch-name')), JSON.stringify(ranked));
    assert.ok(!ranked.some((r) => r.sig.includes('old-branch-name')), `the old file must not have been scanned: ${JSON.stringify(ranked)}`);
  } finally {
    cleanup();
  }
});

// --- min-sessions floor ------------------------------------------------------

test('scanRecurrence: a signature under min-sessions is dropped, not merely ranked low', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'corpus');
    const proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    let lines = '';
    for (const sid of ['a1', 'a2']) { // two sessions only
      lines += `${toolResultLine({ sessionId: sid, timestamp: '2026-09-01T00:00:00Z', text: 'fatal: reference is not a tree: rare-branch-name' })}\n`;
    }
    writeFileSync(join(proj, 's.jsonl'), lines);

    const { ranked } = await scanRecurrence({ root, sinceMs: -Infinity, minSessions: 3 });
    assert.equal(ranked.length, 0, JSON.stringify(ranked));
  } finally {
    cleanup();
  }
});

// --- CLI ----------------------------------------------------------------

test('recurrence.mjs CLI: --json prints ONLY a parseable {ranked, meta} payload on stdout', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'corpus');
    const proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    let lines = '';
    for (const sid of ['c1', 'c2', 'c3']) {
      lines += `${toolResultLine({ sessionId: sid, timestamp: '2026-09-01T00:00:00Z', text: 'fatal: reference is not a tree: cli-branch-name' })}\n`;
    }
    writeFileSync(join(proj, 's.jsonl'), lines);

    const res = runScript('scripts/recurrence.mjs', ['--json', '--min-sessions', '3'], {
      env: {
        AGENT_COMPANION_TRANSCRIPTS_ROOT: root,
        CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
      },
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.json, `stdout was not pure JSON: ${JSON.stringify(res.stdout)}`);
    assert.ok(Array.isArray(res.json.ranked));
    assert.equal(res.json.ranked.length, 1, JSON.stringify(res.json.ranked));
    assert.equal(res.json.ranked[0].sessions, 3);
    assert.ok(res.json.meta);
  } finally {
    cleanup();
  }
});

test('recurrence.mjs CLI: default (human) mode prints the ranked-table header', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'corpus');
    mkdirSync(root, { recursive: true });
    const res = runScript('scripts/recurrence.mjs', [], {
      env: {
        AGENT_COMPANION_TRANSCRIPTS_ROOT: root,
        CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
      },
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /sess\s+proj\s+hits\s+first\.\.last\s+signature/);
  } finally {
    cleanup();
  }
});

// --- Fix 4: never into the repo ---------------------------------------------

test('recurrence.mjs CLI: default write location is under the plugin DATA dir, never cwd/repo', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'corpus');
    mkdirSync(root, { recursive: true });
    const pluginData = join(dir, '.claude', 'plugins', 'data', 'agent-companion-x');
    const res = runScript('scripts/recurrence.mjs', [], {
      env: { AGENT_COMPANION_TRANSCRIPTS_ROOT: root, CLAUDE_PLUGIN_DATA: pluginData },
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const m = res.stderr.match(/wrote \d+ row\(s\) to (.+)$/m);
    assert.ok(m, `no write confirmation on stderr: ${JSON.stringify(res.stderr)}`);
    const writtenPath = m[1].trim();
    assert.ok(
      writtenPath.toLowerCase().startsWith(join(pluginData, 'recurrence-scan').toLowerCase()),
      `expected the artifact under ${join(pluginData, 'recurrence-scan')}, got ${writtenPath}`,
    );
    assert.ok(
      !writtenPath.toLowerCase().includes(PLUGIN_ROOT.toLowerCase()),
      `the written artifact must never land inside the plugin/repo checkout: ${writtenPath}`,
    );
  } finally {
    cleanup();
  }
});

// --- detect.mjs wiring: only what's NEW -------------------------------------

test('detect.mjs: recurring_failures fires once for a new signature, then stays silent', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'corpus');
    const proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    let lines = '';
    for (const sid of ['d1', 'd2', 'd3']) {
      lines += `${toolResultLine({ sessionId: sid, timestamp: '2026-09-01T00:00:00Z', text: 'fatal: detect wiring failure' })}\n`;
    }
    writeFileSync(join(proj, 's.jsonl'), lines);

    const env = {
      AGENT_COMPANION_TRANSCRIPTS_ROOT: root,
      CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
    };

    const run1 = runScript('scripts/detect.mjs', [], { env });
    assert.equal(run1.status, 0, `stderr: ${run1.stderr}`);
    assert.ok(run1.json, `detect.mjs did not emit JSON: ${run1.stdout}`);
    const sig1 = (run1.json.signals || []).find((s) => s.kind === 'recurring_failures');
    assert.ok(sig1, `expected a recurring_failures signal on the first run: ${JSON.stringify(run1.json.signals)}`);
    assert.equal(sig1.dispatch, 'gotcha-capture');
    assert.match(sig1.detail, /detect wiring failure/);

    const run2 = runScript('scripts/detect.mjs', [], { env });
    assert.equal(run2.status, 0, `stderr: ${run2.stderr}`);
    const sig2 = (run2.json.signals || []).find((s) => s.kind === 'recurring_failures');
    assert.equal(sig2, undefined, `must be silent once already reported: ${JSON.stringify(run2.json.signals)}`);
  } finally {
    cleanup();
  }
});

test('detect.mjs: recurrence_scan=false gates the check off without advancing its cursor', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'corpus');
    const proj = join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    let lines = '';
    for (const sid of ['g1', 'g2', 'g3']) {
      lines += `${toolResultLine({ sessionId: sid, timestamp: '2026-09-01T00:00:00Z', text: 'fatal: reference is not a tree: gated-branch-name' })}\n`;
    }
    writeFileSync(join(proj, 's.jsonl'), lines);

    const pluginData = join(dir, '.claude', 'plugins', 'data', 'agent-companion-x');
    const offRun = runScript('scripts/detect.mjs', [], {
      env: {
        AGENT_COMPANION_TRANSCRIPTS_ROOT: root,
        CLAUDE_PLUGIN_DATA: pluginData,
        CLAUDE_PLUGIN_OPTION_RECURRENCE_SCAN: 'false',
      },
    });
    assert.equal(offRun.status, 0, `stderr: ${offRun.stderr}`);
    assert.equal(
      (offRun.json.signals || []).find((s) => s.kind === 'recurring_failures'),
      undefined,
      `the check must not run at all while gated off: ${JSON.stringify(offRun.json.signals)}`,
    );

    // Gate back on: the still-new signature must now surface — proving the
    // gated-off run never silently consumed it (the cursor-vs-checkedAt bug
    // this wiring specifically guards against).
    const onRun = runScript('scripts/detect.mjs', [], {
      env: { AGENT_COMPANION_TRANSCRIPTS_ROOT: root, CLAUDE_PLUGIN_DATA: pluginData },
    });
    assert.equal(onRun.status, 0, `stderr: ${onRun.stderr}`);
    const sig = (onRun.json.signals || []).find((s) => s.kind === 'recurring_failures');
    assert.ok(sig, `expected the gated signature to surface once re-enabled: ${JSON.stringify(onRun.json.signals)}`);
  } finally {
    cleanup();
  }
});
