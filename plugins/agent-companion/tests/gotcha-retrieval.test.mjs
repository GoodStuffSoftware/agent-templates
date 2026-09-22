// Tests for hooks/gotcha-retrieval.mjs (the PostToolUseFailure gotcha
// retrieval hook) and its wiring into hooks/hooks.json. See
// docs/adr/0002-stack-scoped-gotcha-retrieval.md.
//
// No test touches the real ~/.claude — every fixture uses makeFixture() and
// writes its own scratch memory file under the fixture's own
// AGENT_COMPANION_HOME_OVERRIDE. Every payload carries a `cwd` pointing at
// the fixture's own temp directory (which has no `.git`), so
// findRepoRoot() never reaches this repository's own real lessons/ corpus
// — user scope (the fixture's memory file) is the only candidate source in
// every test here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeFixture, runHook, readJsonl, PLUGIN_ROOT,
} from './helpers.mjs';

function seedMemoryFile(dir, {
  project = 'demo-project', file = 'gotchas.md', frontmatter, body = 'Body text.',
}) {
  const memDir = join(dir, '.claude', 'projects', project, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, file), `---\n${frontmatter}\n---\n${body}\n`);
}

// Deliberately NOT a `test-`/`fixture-`/`verify-`/`canary`-prefixed session
// id: hooks/lib/context.mjs's isFixtureSession() treats those as
// verification traffic and this hook honors that same convention for its
// own miss log (see recordMiss()) — a session id here that matched it would
// silently suppress the very write the miss tests assert on. One dedicated
// test below (`session routing`) exercises the exclusion itself instead.
function payload(overrides = {}) {
  return {
    session_id: 'demo-session-1',
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'whatever' },
    tool_use_id: 'tool-use-1',
    ...overrides,
  };
}

// --- match --------------------------------------------------------------

test('gotcha-retrieval: a matching symptom emits additionalContext with the marker, title, and body', () => {
  const { dir, cleanup } = makeFixture();
  try {
    seedMemoryFile(dir, {
      frontmatter: [
        'name: fixture-enoent-gotcha',
        'description: ENOENT means the lookup failed, check what should have created the path.',
        'symptoms: [no such file or directory]',
        'sessions: 42',
      ].join('\n'),
    });

    const res = runHook('hooks/gotcha-retrieval.mjs', payload({
      tool_error: "Error: ENOENT: no such file or directory, open '/some/path.tmp'",
      cwd: dir,
    }), { env: { AGENT_COMPANION_HOME_OVERRIDE: dir } });

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.json, `expected JSON on stdout, got: ${JSON.stringify(res.stdout)}`);
    const ctx = res.json.hookSpecificOutput?.additionalContext;
    assert.ok(ctx, `expected additionalContext: ${JSON.stringify(res.json)}`);
    assert.ok(ctx.startsWith('[agent-companion: gotcha]'), `marker must be the verbatim first line: ${JSON.stringify(ctx)}`);
    assert.match(ctx, /fixture-enoent-gotcha/);
    assert.match(ctx, /ENOENT means the lookup failed/);
    assert.equal(res.json.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  } finally {
    cleanup();
  }
});

test('gotcha-retrieval: matching is normalized — a different prefix, irregular whitespace, and case all still hit', () => {
  const { dir, cleanup } = makeFixture();
  try {
    seedMemoryFile(dir, {
      frontmatter: [
        'name: fixture-git-fatal',
        'symptoms: [Not A Valid Object Name]',
      ].join('\n'),
    });

    const res = runHook('hooks/gotcha-retrieval.mjs', payload({
      // Different prefix (bare, no "fatal:") AND irregular internal
      // whitespace/newline than the authored key's own casing.
      tool_error: 'fatal:   not a valid\n  object name: HEAD',
      cwd: dir,
    }), { env: { AGENT_COMPANION_HOME_OVERRIDE: dir } });

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.json?.hookSpecificOutput?.additionalContext, `expected a match: ${res.stdout}`);
  } finally {
    cleanup();
  }
});

test('gotcha-retrieval: several matching entries — the higher `sessions:` one wins, not filesystem order', () => {
  const { dir, cleanup } = makeFixture();
  try {
    seedMemoryFile(dir, {
      file: 'a-low.md',
      frontmatter: ['name: low-count', 'symptoms: [widget failed to load]', 'sessions: 2'].join('\n'),
    });
    seedMemoryFile(dir, {
      file: 'z-high.md',
      frontmatter: ['name: high-count', 'symptoms: [widget failed to load]', 'sessions: 40'].join('\n'),
    });

    const res = runHook('hooks/gotcha-retrieval.mjs', payload({
      tool_error: 'Error: widget failed to load unexpectedly',
      cwd: dir,
    }), { env: { AGENT_COMPANION_HOME_OVERRIDE: dir } });

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const ctx = res.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /high-count/, `expected the higher-sessions entry to win: ${JSON.stringify(ctx)}`);
  } finally {
    cleanup();
  }
});

test('gotcha-retrieval: never injects the same entry twice for the same tool_use_id', () => {
  const { dir, cleanup } = makeFixture();
  try {
    seedMemoryFile(dir, {
      frontmatter: ['name: dedup-fixture', 'symptoms: [dedup marker phrase]'].join('\n'),
    });
    const env = { AGENT_COMPANION_HOME_OVERRIDE: dir };
    const p = payload({ tool_error: 'Error: dedup marker phrase seen again', cwd: dir, tool_use_id: 'same-id' });

    const first = runHook('hooks/gotcha-retrieval.mjs', p, { env });
    assert.ok(first.json?.hookSpecificOutput?.additionalContext, `first call should match: ${first.stdout}`);

    const second = runHook('hooks/gotcha-retrieval.mjs', p, { env });
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);
    assert.equal(second.json, null, `second call for the same tool_use_id must emit nothing: ${second.stdout}`);
  } finally {
    cleanup();
  }
});

// --- no-match / capture-on-miss ------------------------------------------

test('gotcha-retrieval: no match emits nothing and writes a capped, normalized miss row (never to the repo)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    seedMemoryFile(dir, {
      frontmatter: ['name: unrelated', 'symptoms: [totally different phrase]'].join('\n'),
    });

    const res = runHook('hooks/gotcha-retrieval.mjs', payload({
      tool_error: 'Error: ECONNREFUSED talking to a service nobody seeded a key for',
      cwd: dir,
    }), { env: { AGENT_COMPANION_HOME_OVERRIDE: dir } });

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.stdout.trim(), '', `a miss must produce no stdout: ${JSON.stringify(res.stdout)}`);

    const missFile = join(
      dir, '.claude', 'plugins', 'data', 'agent-companion-agent-templates', 'gotcha-capture', 'misses.jsonl',
    );
    assert.ok(existsSync(missFile), `expected a miss row written under the plugin data dir: ${missFile}`);
    const rows = readJsonl(missFile);
    assert.equal(rows.length, 1);
    assert.match(rows[0].signature, /econnrefused/i);
    assert.equal(rows[0].session_id, 'demo-session-1');

    // Never the repo: the write location itself must be under the fixture's
    // OWN isolated temp dir, never inside this checkout.
    assert.ok(
      !missFile.toLowerCase().includes(PLUGIN_ROOT.toLowerCase()),
      `miss log must never land inside the plugin/repo checkout: ${missFile}`,
    );
  } finally {
    cleanup();
  }
});

test('gotcha-retrieval: a test-/verify-/fixture-/canary session id never writes a miss row (same convention as the rest of the plugin)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/gotcha-retrieval.mjs', payload({
      session_id: 'test-a-verification-run',
      tool_error: 'Error: ECONNREFUSED this must never be logged',
      cwd: dir,
    }), { env: { AGENT_COMPANION_HOME_OVERRIDE: dir } });

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const missFile = join(
      dir, '.claude', 'plugins', 'data', 'agent-companion-agent-templates', 'gotcha-capture', 'misses.jsonl',
    );
    assert.ok(!existsSync(missFile), `a fixture/verification session id must never produce a miss row: ${missFile}`);
  } finally {
    cleanup();
  }
});

test('gotcha-retrieval: a key shorter than the minimum distinctiveness floor never matches', () => {
  const { dir, cleanup } = makeFixture();
  try {
    seedMemoryFile(dir, {
      frontmatter: ['name: too-short', 'symptoms: [error]'].join('\n'),
    });

    const res = runHook('hooks/gotcha-retrieval.mjs', payload({
      tool_error: 'Error: something failed for reasons',
      cwd: dir,
    }), { env: { AGENT_COMPANION_HOME_OVERRIDE: dir } });

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.json, null, `a bare, generic key must not match: ${res.stdout}`);
  } finally {
    cleanup();
  }
});

// --- fail-open ------------------------------------------------------------

test('gotcha-retrieval: fails open on empty stdin, garbage stdin, and a non-string tool_error', () => {
  const { dir, cleanup } = makeFixture();
  const env = { AGENT_COMPANION_HOME_OVERRIDE: dir };
  try {
    const empty = runHook('hooks/gotcha-retrieval.mjs', undefined, { env });
    assert.equal(empty.status, 0, `stderr: ${empty.stderr}`);
    assert.equal(empty.stdout.trim(), '');

    const garbage = runHook('hooks/gotcha-retrieval.mjs', '{not valid json!!', { env });
    assert.equal(garbage.status, 0, `stderr: ${garbage.stderr}`);
    assert.equal(garbage.stdout.trim(), '');

    const nonString = runHook(
      'hooks/gotcha-retrieval.mjs',
      payload({ tool_error: { message: 'object, not a string' }, cwd: dir }),
      { env },
    );
    assert.equal(nonString.status, 0, `stderr: ${nonString.stderr}`);
    assert.equal(nonString.stdout.trim(), '');
  } finally {
    cleanup();
  }
});

test('gotcha-retrieval: gotcha_retrieval=false gates the hook off entirely, even on an otherwise-matching error', () => {
  const { dir, cleanup } = makeFixture();
  try {
    seedMemoryFile(dir, {
      frontmatter: ['name: gated-off-fixture', 'symptoms: [no such file or directory]'].join('\n'),
    });

    const res = runHook('hooks/gotcha-retrieval.mjs', payload({
      tool_error: "Error: ENOENT: no such file or directory, open 'x'",
      cwd: dir,
    }), {
      env: {
        AGENT_COMPANION_HOME_OVERRIDE: dir,
        CLAUDE_PLUGIN_OPTION_GOTCHA_RETRIEVAL: 'false',
      },
    });

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.json, null, `must emit nothing while gated off: ${res.stdout}`);
  } finally {
    cleanup();
  }
});

test('gotcha-retrieval: an unwritable data directory (a file where a directory belongs) still exits cleanly', () => {
  const { dir, cleanup } = makeFixture();
  try {
    // Force CLAUDE_PLUGIN_DATA to point at a path that is already a FILE —
    // every mkdirSync the hook attempts underneath it must fail, and the
    // hook must still exit 0 with no crash (same technique
    // standing-rules.test.mjs uses for its own "fails open" case).
    const fakeDataDir = join(dir, 'not-a-directory.txt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fakeDataDir, 'this is a file, not a directory');

    const res = runHook('hooks/gotcha-retrieval.mjs', payload({
      tool_error: 'Error: ECONNREFUSED nothing seeded for this one either',
      cwd: dir,
    }), {
      env: { AGENT_COMPANION_HOME_OVERRIDE: dir, CLAUDE_PLUGIN_DATA: fakeDataDir },
    });

    assert.equal(res.status, 0, `must never crash even when its own disk writes fail: ${res.stderr}`);
  } finally {
    cleanup();
  }
});

// --- hooks.json wiring: the PowerShell matcher ----------------------------

test('hooks.json: PostToolUseFailure is registered on gotcha-retrieval.mjs with a matcher that actually matches PowerShell, not just Bash', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8');
  const config = JSON.parse(raw);
  const entries = config.hooks?.PostToolUseFailure || [];
  const target = entries.find((e) => (e.hooks || []).some((h) => (h.args || []).some((a) => String(a).includes('gotcha-retrieval.mjs'))));
  assert.ok(target, `expected a PostToolUseFailure entry registering gotcha-retrieval.mjs: ${JSON.stringify(entries)}`);
  assert.ok(target.matcher, 'expected a matcher string');

  // Compiled and actually tested against both tool names — not just a
  // substring search over the matcher text — because a matcher that merely
  // MENTIONS "PowerShell" without being a well-formed alternation would
  // still silently never fire for it.
  const re = new RegExp(target.matcher);
  assert.ok(re.test('PowerShell'), `matcher "${target.matcher}" must match "PowerShell"`);
  assert.ok(re.test('Bash'), `matcher "${target.matcher}" must match "Bash"`);
});
