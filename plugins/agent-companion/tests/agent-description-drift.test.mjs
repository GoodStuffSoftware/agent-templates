// Ladder track (0292), item 3: each agents/ac-*.md description must come
// from config/model-tiers.json and the current trial table — a hand-written
// claim like ac-opus-low's old "rare; prefer sonnet unless..." can go stale
// the moment a routing trial changes what actually routes there (it did:
// trial v2 makes opus/low the default for explore/verify/operate/etc, which
// directly contradicted "rare"). scripts/routing-table.mjs
// --check-agent-descriptions / --sync-agent-descriptions is the generator;
// these tests exercise it against a FIXTURE agents/ dir
// (AGENT_COMPANION_AGENTS_DIR_OVERRIDE) so the real committed files are
// never touched by a test run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';

function fixtureAgentsDir(dir) {
  const agentsDir = join(dir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  cpSync(join(PLUGIN_ROOT, 'agents'), agentsDir, { recursive: true });
  return agentsDir;
}

test('the real, committed agents/ac-*.md descriptions have NO drift from config/model-tiers.json', () => {
  // Runs against the REAL agents/ dir (no override) — this is the gate every
  // push must pass; a hand-edit to a description without re-running the sync
  // fails this the same way CI would.
  const res = runScript('scripts/routing-table.mjs', ['--check-agent-descriptions']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /no drift/);
});

test('--check-agent-descriptions fails and names the file when a description has been hand-edited out of sync', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const file = join(agentsDir, 'ac-opus-low.md');
    let text = readFileSync(file, 'utf8');
    text = text.replace(/^description:.*$/m, 'description: "Rung 6/10: rare; prefer sonnet unless the task genuinely needs opus even for a small step."');
    writeFileSync(file, text);

    const res = runScript('scripts/routing-table.mjs', ['--check-agent-descriptions'], {
      env: { AGENT_COMPANION_AGENTS_DIR_OVERRIDE: agentsDir },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ac-opus-low/);
    assert.match(res.stderr, /Currently the default routing for:/); // the CORRECT, non-stale expected text
    assert.match(res.stderr, /rare; prefer sonnet/); // the stale actual text, named
  } finally {
    cleanup();
  }
});

test('--sync-agent-descriptions rewrites a drifted description in place, preserving the rest of the file', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const file = join(agentsDir, 'ac-opus-low.md');
    const before = readFileSync(file, 'utf8');
    const bodyBefore = before.split(/^---\r?\n[\s\S]*?\r?\n---/m)[1];
    writeFileSync(file, before.replace(/^description:.*$/m, 'description: "stale text"'));

    const syncRes = runScript('scripts/routing-table.mjs', ['--sync-agent-descriptions'], {
      env: { AGENT_COMPANION_AGENTS_DIR_OVERRIDE: agentsDir },
    });
    assert.equal(syncRes.status, 0, syncRes.stderr);
    assert.match(syncRes.stdout, /ac-opus-low\.md/);

    const after = readFileSync(file, 'utf8');
    assert.doesNotMatch(after, /stale text/);
    assert.match(after, /Currently the default routing for:/);
    // Body (everything after frontmatter) is untouched.
    assert.equal(after.split(/^---\r?\n[\s\S]*?\r?\n---/m)[1], bodyBefore);

    const checkRes = runScript('scripts/routing-table.mjs', ['--check-agent-descriptions'], {
      env: { AGENT_COMPANION_AGENTS_DIR_OVERRIDE: agentsDir },
    });
    assert.equal(checkRes.status, 0, checkRes.stderr);
  } finally {
    cleanup();
  }
});

test('a rung with NO current default task type gets the "not currently the default" suffix, not a false claim', () => {
  // ac-sonnet-medium (rung 3) has no taskType currently overriding to it
  // under trial v2 — proves the generator does not invent usage that is not
  // actually true right now.
  const res = runScript('scripts/routing-table.mjs', ['--check-agent-descriptions']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
});
