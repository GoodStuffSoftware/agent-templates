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

// --- cacheTtl coverage (ladder track "rungttl", 2026-09-26) ----------------
// The same --check/--sync pair also generates/verifies the nested
// `experimental.cacheTtl` frontmatter block from each rung's own config
// `cacheTtl` field (independent of the description text).

test('mutation: a rung config gives a NEW cacheTtl:"1h" that its file lacks fails the check as cache-ttl-drift', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    writeLadderOverride(stateDir, shippedLadder().map((r) => (r.agent === 'ac-sonnet-low' ? { ...r, cacheTtl: '1h' } : r)));
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-sonnet-low \[cache-ttl-drift\]/);
    assert.match(res.stderr, /expected: experimental\.cacheTtl: "1h"/);
    assert.match(res.stderr, /actual:\s+\(absent\)/);
  } finally {
    cleanup();
  }
});

test('--sync-agent-descriptions adds the experimental.cacheTtl block for a rung config newly marks "1h", leaving the rest of the file untouched', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    writeLadderOverride(stateDir, shippedLadder().map((r) => (r.agent === 'ac-sonnet-low' ? { ...r, cacheTtl: '1h' } : r)));
    const file = join(agentsDir, 'ac-sonnet-low.md');
    const before = readFileSync(file, 'utf8');

    assert.equal(sync(agentsDir).status, 0);
    const after = readFileSync(file, 'utf8');
    assert.match(after, /experimental:\r?\n\s+cacheTtl: "1h"/);
    // Nothing else in the frontmatter or body changed.
    assert.equal(after.replace(/experimental:\r?\n\s+cacheTtl: "1h"\r?\n/, ''), before);

    assert.equal(check(agentsDir).status, 0);
    // Idempotent: syncing again writes nothing further.
    const secondSync = sync(agentsDir);
    assert.equal(secondSync.status, 0);
    assert.match(secondSync.stdout, /no agent descriptions needed updating/);
  } finally {
    cleanup();
  }
});

test('mutation: a rung config REMOVES a cacheTtl:"1h" the file still carries also fails as cache-ttl-drift, and --sync removes the block', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const file = join(agentsDir, 'ac-opus-high.md');
    const original = readFileSync(file, 'utf8'); // shipped file already carries the 1h block
    assert.match(original, /cacheTtl: "1h"/);

    writeLadderOverride(stateDir, shippedLadder().map((r) => (r.agent === 'ac-opus-high' ? { ...r, cacheTtl: undefined } : r)));
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-opus-high \[cache-ttl-drift\]/);
    assert.match(res.stderr, /expected: no experimental\.cacheTtl block/);
    assert.match(res.stderr, /actual:\s+experimental\.cacheTtl: "1h"/);

    assert.equal(sync(agentsDir).status, 0);
    const after = readFileSync(file, 'utf8');
    assert.doesNotMatch(after, /experimental/);
    assert.doesNotMatch(after, /cacheTtl/);
    assert.equal(check(agentsDir).status, 0);
  } finally {
    cleanup();
  }
});

// --- Coverage is driven by config/model-tiers.json (round 2) ---------------
// Each mutation below must FAIL the check. A per-machine model-tiers.json
// override in the fixture's state root replaces the `ladder` wholesale, and
// AGENT_COMPANION_AGENTS_DIR_OVERRIDE points at a fixture copy of agents/.

function shippedLadder() {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8')).ladder;
}
function writeLadderOverride(stateDir, ladder) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'model-tiers.json'), JSON.stringify({ ladder }));
}
function check(agentsDir) {
  return runScript('scripts/routing-table.mjs', ['--check-agent-descriptions'], {
    env: { AGENT_COMPANION_AGENTS_DIR_OVERRIDE: agentsDir },
  });
}

test('mutation: adding a rung to config fails the check (no file for it, and every "/N" count is now wrong)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    writeLadderOverride(stateDir, [...shippedLadder(), { rung: 11, model: 'opus', effort: 'max', agent: 'ac-opus-extra', role: 'a new rung' }]);
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-opus-extra \[missing-file\]/);
    assert.match(res.stderr, /Rung 6\/11/); // counts come from ladder.length, not a literal 10
  } finally {
    cleanup();
  }
});

test('mutation: a rung with no role text in config fails the check (never a silent skip)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    writeLadderOverride(stateDir, shippedLadder().map((r) => (r.agent === 'ac-sonnet-high' ? { ...r, role: undefined } : r)));
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-sonnet-high \[no-role\]/);
  } finally {
    cleanup();
  }
});

test('mutation: renaming a rung in config fails the check (the new name has no file, the old file is no longer a rung)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    writeLadderOverride(stateDir, shippedLadder().map((r) => (r.agent === 'ac-opus-low' ? { ...r, agent: 'ac-opus-small' } : r)));
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-opus-small \[missing-file\]/);
    assert.match(res.stderr, /ac-opus-low \[not-a-rung\]/);
  } finally {
    cleanup();
  }
});

test('mutation: a false claim in a description fails the check, including ac-haiku\'s', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const haiku = join(agentsDir, 'ac-haiku.md');
    writeFileSync(haiku, readFileSync(haiku, 'utf8').replace(/^description:.*$/m, 'description: "Rung 1/10: the default routing for every task type."'));
    const med = join(agentsDir, 'ac-sonnet-medium.md');
    writeFileSync(med, readFileSync(med, 'utf8').replace(/^description:.*$/m, 'description: "Rung 3/10: bounded multi-step work against a clear spec (1-3 files, known shape). Currently the default routing for: explore."'));
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-haiku \[drift\]/);
    assert.match(res.stderr, /ac-sonnet-medium \[drift\]/);
  } finally {
    cleanup();
  }
});

// Round 3: a routing claim written into a config `role` (which --sync then
// copies into the description) is checked too.
function sync(agentsDir) {
  return runScript('scripts/routing-table.mjs', ['--sync-agent-descriptions'], {
    env: { AGENT_COMPANION_AGENTS_DIR_OVERRIDE: agentsDir },
  });
}

test('mutation: a FALSE "default for <type>" claim in a config role fails the check, even after --sync', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    // verify routes to opus/low, not sonnet/low.
    writeLadderOverride(stateDir, shippedLadder().map((r) => (r.agent === 'ac-sonnet-low' ? { ...r, role: `${r.role}; default for verify` } : r)));
    assert.equal(sync(agentsDir).status, 0);
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-sonnet-low \[false-claim\]/);
    assert.match(res.stderr, /"verify" currently routes to opus\/low, not this rung/);
  } finally {
    cleanup();
  }
});

test('a TRUE "default for <type>" claim in a config role passes once synced', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    writeLadderOverride(stateDir, shippedLadder().map((r) => (r.agent === 'ac-opus-low' ? { ...r, role: `${r.role}; default for verify` } : r)));
    assert.equal(sync(agentsDir).status, 0);
    const res = check(agentsDir);
    assert.equal(res.status, 0, res.stdout + res.stderr);
  } finally {
    cleanup();
  }
});

test('mutation: any other routing word in a config role (rare, prefer, typically, reserve, weight-N...) fails the check', () => {
  for (const claim of ['rare; prefer sonnet unless needed', 'typically used for reviews', 'reserve for weight-5 work', 'usually the default']) {
    const { dir, stateDir, cleanup } = makeFixture();
    try {
      const agentsDir = fixtureAgentsDir(dir);
      writeLadderOverride(stateDir, shippedLadder().map((r) => (r.agent === 'ac-opus-medium' ? { ...r, role: `${r.role} — ${claim}` } : r)));
      assert.equal(sync(agentsDir).status, 0);
      const res = check(agentsDir);
      assert.equal(res.status, 1, `${claim}: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /ac-opus-medium \[unverifiable-claim\]/, claim);
    } finally {
      cleanup();
    }
  }
});

test('mutation: a file whose name: is not its rung fails the check', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const f = join(agentsDir, 'ac-opus-max.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^name:.*$/m, 'name: ac-opus-maximum'));
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-opus-max \[name-mismatch\]/);
  } finally {
    cleanup();
  }
});

test('ac-haiku: generated from the tier\'s retiresAfter and replacement, keeps RETIRING, and no longer claims "verification"', () => {
  const text = readFileSync(join(PLUGIN_ROOT, 'agents', 'ac-haiku.md'), 'utf8');
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));
  const desc = text.match(/^description:\s*"(.*)"$/m)[1];
  assert.match(desc, new RegExp(`^RETIRING \\(no sooner than ${cfg.tiers.haiku.retiresAfter}\\)`));
  assert.match(desc, new RegExp(`falls back to rung \\d+, ac-${cfg.tiers.haiku.replacement.model}-${cfg.tiers.haiku.replacement.effort}`));
  assert.doesNotMatch(desc, /verification/);
});

test('every "Not currently the default" and "Currently the default routing for" claim is true against the live routes', async () => {
  const { cleanup } = makeFixture();
  try {
    const { resolveRoute, modelTiers } = await import('../hooks/lib/context.mjs');
    const cfg = modelTiers();
    const routes = Object.entries(cfg.taskTypes).filter(([, t]) => typeof t.weight === 'number')
      .map(([name]) => [name, resolveRoute({ type: name, profile: false })]);
    let sawNone = false;
    for (const rung of cfg.ladder) {
      const desc = readFileSync(join(PLUGIN_ROOT, 'agents', `${rung.agent}.md`), 'utf8').match(/^description:\s*"?(.*?)"?$/m)[1];
      const actual = routes.filter(([, r]) => r.model === rung.model && (r.effort || null) === (rung.effort || null)).map(([n]) => n);
      if (/Not currently the default routing/.test(desc)) {
        sawNone = true;
        assert.deepEqual(actual, [], `${rung.agent} says no task type routes to it`);
      } else {
        const claimed = desc.match(/Currently the default routing for: ([^.]*)\./)[1].split(', ');
        assert.deepEqual(claimed, actual, rung.agent);
      }
    }
    assert.ok(sawNone, 'at least one rung carries the "not currently the default" suffix');
  } finally {
    cleanup();
  }
});