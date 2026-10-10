// Ladder track (0292), item 3: each agents/ac-*.md description must come
// from config/model-tiers.json and the current trial table — a hand-written
// claim like ac-opus-low's old "rare; prefer sonnet unless..." can go stale
// the moment a routing trial changes what actually routes there (it did:
// trial v2 made opus/low the default for explore/verify/operate/etc, which
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
    const file = join(agentsDir, 'ac-sonnet-low.md');
    let text = readFileSync(file, 'utf8');
    text = text.replace(/^description:.*$/m, 'description: "Rung 6/10: rare; prefer sonnet unless the task genuinely needs opus even for a small step."');
    writeFileSync(file, text);

    const res = runScript('scripts/routing-table.mjs', ['--check-agent-descriptions'], {
      env: { AGENT_COMPANION_AGENTS_DIR_OVERRIDE: agentsDir },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ac-sonnet-low/);
    assert.match(res.stderr, /Base default for:/); // the CORRECT, non-stale expected text
    assert.match(res.stderr, /rare; prefer sonnet/); // the stale actual text, named
  } finally {
    cleanup();
  }
});

test('--sync-agent-descriptions rewrites a drifted description in place, preserving the rest of the file', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const file = join(agentsDir, 'ac-sonnet-low.md');
    const before = readFileSync(file, 'utf8');
    const bodyBefore = before.split(/^---\r?\n[\s\S]*?\r?\n---/m)[1];
    writeFileSync(file, before.replace(/^description:.*$/m, 'description: "stale text"'));

    const syncRes = runScript('scripts/routing-table.mjs', ['--sync-agent-descriptions'], {
      env: { AGENT_COMPANION_AGENTS_DIR_OVERRIDE: agentsDir },
    });
    assert.equal(syncRes.status, 0, syncRes.stderr);
    assert.match(syncRes.stdout, /ac-sonnet-low\.md/);

    const after = readFileSync(file, 'utf8');
    assert.doesNotMatch(after, /stale text/);
    assert.match(after, /Base default for:/);
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

test('no shipped ladder rung carries experimental.cacheTtl (all ten use the 5m subagent default, 2026-10-03)', () => {
  for (const r of shippedLadder()) {
    assert.equal(r.cacheTtl, undefined, `${r.agent}: config ladder must not set cacheTtl`);
    const text = readFileSync(join(PLUGIN_ROOT, 'agents', `${r.agent}.md`), 'utf8');
    assert.doesNotMatch(text, /cacheTtl/, `${r.agent}.md must not carry a cacheTtl block`);
  }
});

test('mutation: a file that still carries a cacheTtl:"1h" its rung config does not set fails as cache-ttl-drift, and --sync removes the block', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const file = join(agentsDir, 'ac-opus-high.md');
    // The shipped file has no block (all rungs are on the 5m default); put a
    // stale 1h block into the fixture copy, as an old install would carry.
    const shipped = readFileSync(file, 'utf8');
    const original = shipped.replace(/^(effort: [^\r\n]*)(\r?\n)/m, '$1$2experimental:$2  cacheTtl: "1h"$2');
    assert.notEqual(original, shipped);
    writeFileSync(file, original);
    assert.match(original, /cacheTtl: "1h"/);

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
    writeFileSync(med, readFileSync(med, 'utf8').replace(/^description:.*$/m, 'description: "Rung 3/10: bounded multi-step work against a clear spec (1-3 files, known shape). Base-table default routing for: explore; your routing profile may route differently, see /ac routing."'));
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
    // verify routes to haiku, not sonnet/low.
    writeLadderOverride(stateDir, shippedLadder().map((r) => (r.agent === 'ac-sonnet-low' ? { ...r, role: `${r.role}; default for verify` } : r)));
    assert.equal(sync(agentsDir).status, 0);
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-sonnet-low \[false-claim\]/);
    assert.match(res.stderr, /"verify" currently routes to haiku, not this rung/);
  } finally {
    cleanup();
  }
});

test('a TRUE "default for <type>" claim in a config role passes once synced', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    writeLadderOverride(stateDir, shippedLadder().map((r) => (r.agent === 'ac-haiku' ? { ...r, role: `${r.role}; default for verify` } : r)));
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
  assert.match(desc, new RegExp(`[Ff]alls back to ac-${cfg.tiers.haiku.replacement.model}-${cfg.tiers.haiku.replacement.effort}`));
  assert.doesNotMatch(desc, /verification/);
});

test('every "Base default for" claim is true against the shipped routes, and says the profile may differ', async () => {
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
      if (!/Base default for:/.test(desc)) {
        // A rung that is no type's base default makes no claim (0.31.9), so it carries no suffix.
        sawNone = true;
        assert.deepEqual(actual, [], `${rung.agent} says no task type routes to it`);
      } else {
        // A claim names where it stops: the routing profile may differ.
        assert.match(desc, /Base default for: [^;]*; profile may differ\./, `${rung.agent} points at the routing profile`);
        const claimed = desc.match(/Base default for: ([^;]*);/)[1].split(', ');
        assert.deepEqual(claimed, actual, rung.agent);
      }
    }
    assert.ok(sawNone, 'at least one rung carries no "Base default for" claim');
  } finally {
    cleanup();
  }
});

// --- Short descriptions (S5) and generated tool policy (S1/S2) --------------

test('every ac-* description is short: at most 260 chars (the haiku retirement notice), at most 175 for every other agent', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));
  for (const a of [...cfg.ladder, ...cfg.ladderVariants]) {
    const desc = readFileSync(join(PLUGIN_ROOT, 'agents', `${a.agent}.md`), 'utf8').match(/^description:\s*"?(.*?)"?$/m)[1];
    assert.ok(desc.length <= (a.agent === 'ac-haiku' ? 260 : 175), `${a.agent}: ${desc.length} chars`);
  }
});

function toolsLine(agent) {
  const m = readFileSync(join(PLUGIN_ROOT, 'agents', `${agent}.md`), 'utf8').match(/^disallowedTools:\s*(.*)$/m);
  return m ? m[1].split(',').map((x) => x.trim()) : null;
}

test('every numbered rung drops Artifact, the desktop-only servers and the browser servers; the browser variants keep the browser', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));
  for (const r of cfg.ladder) {
    const t = toolsLine(r.agent);
    for (const must of ['Artifact', 'ArtifactComments', 'ArtifactData', 'ArtifactCheck', 'mcp__visualize', 'mcp__terminal', 'mcp__ccd_session', 'mcp__Claude_Browser', 'mcp__claude-in-chrome', 'mcp__computer-use', 'Skill']) {
      assert.ok(t.includes(must), `${r.agent} drops ${must}`);
    }
    // keepOn: ccd_session_mgmt stays on ac-haiku only
    assert.equal(t.includes('mcp__ccd_session_mgmt'), r.agent !== 'ac-haiku', r.agent);
  }
  for (const v of cfg.ladderVariants) {
    const t = toolsLine(v.agent);
    for (const a of ['Artifact', 'ArtifactComments', 'ArtifactData', 'ArtifactCheck']) assert.ok(t.includes(a), `${v.agent} drops ${a}`);
    for (const keep of ['mcp__Claude_Browser', 'mcp__claude-in-chrome', 'mcp__computer-use', 'Skill']) assert.ok(!t.includes(keep), `${v.agent} keeps ${keep}`);
  }
});

test('no account-specific connector id is in any ac-* tools line', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));
  for (const a of [...cfg.ladder, ...cfg.ladderVariants]) {
    assert.doesNotMatch(toolsLine(a.agent).join(','), /[0-9a-f]{8}-[0-9a-f]{4}-/, a.agent);
  }
});

test('mutation: a rung whose disallowedTools line was hand-edited fails the check as tools-drift, and --sync restores it', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const file = join(agentsDir, 'ac-opus-high.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^disallowedTools:.*$/m, 'disallowedTools: Artifact'));
    const res = check(agentsDir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /ac-opus-high \[tools-drift\]/);
    assert.equal(sync(agentsDir).status, 0);
    assert.equal(check(agentsDir).status, 0);
    assert.ok(toolsLine('ac-opus-high').length > 1);
  } finally {
    cleanup();
  }
});

test('mutation: a rung file with no disallowedTools line fails as tools-drift (absent)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const file = join(agentsDir, 'ac-sonnet-low.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^disallowedTools:.*\r?\n/m, ''));
    const res = check(agentsDir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ac-sonnet-low \[tools-drift\][\s\S]*actual:\s+\(absent\)/);
  } finally {
    cleanup();
  }
});

test('mutation: a browser variant that lost the browser, or a variant file with no config entry, fails', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = fixtureAgentsDir(dir);
    const file = join(agentsDir, 'ac-browser.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^disallowedTools:.*$/m, (l) => `${l}, mcp__Claude_Browser`));
    const res = check(agentsDir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ac-browser \[tools-drift\]/);
    writeFileSync(join(agentsDir, 'ac-stray.md'), '---\nname: ac-stray\n---\n');
    assert.match(check(agentsDir).stderr, /ac-stray \[not-a-rung\]/);
  } finally {
    cleanup();
  }
});

test('a variant is not a rung: rungFor never returns it, and the guards count it as a ladder agent', async () => {
  const { cleanup } = makeFixture();
  try {
    const ctx = await import('../hooks/lib/context.mjs');
    for (const v of ctx.ladderVariants()) {
      assert.equal(v.rung, null);
      assert.ok(ctx.isLadderAgentName(v.agent), v.agent);
      assert.ok(ctx.isLadderAgentName(`agent-companion:${v.agent}`), v.agent);
      assert.notEqual(ctx.rungFor(v.model, v.effort).agent, v.agent);
    }
    assert.ok(ctx.ladderVariants().some((v) => v.agent === 'ac-browser'));
  } finally {
    cleanup();
  }
});
