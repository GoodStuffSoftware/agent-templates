// Lean listings (0.31.11): a ladder worker starts without the skill listing, and
// without any connector name the plugin could not name safely.
//
// Measured on the 2026-10 week, the listings the harness injects at worker
// start and after each compaction cost: skill listing 4.16% of the weekly
// limit, deferred-tool names 2.92%, agent listing 1.49%, most of it in
// subagents. A `disallowedTools` entry drops a tool's schema, its deferred name
// and (for Skill and Agent) the listing. This file pins the Skill deny on every
// ladder rung, the browser variants keeping it, no account-specific connector
// id in a shipped file, and the shorter descriptions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';

const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));

function frontmatter(agent) {
  const text = readFileSync(join(PLUGIN_ROOT, 'agents', `${agent}.md`), 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, `${agent}: no frontmatter`);
  return m[1];
}
function denied(agent) {
  const line = frontmatter(agent).split(/\r?\n/).find((l) => /^disallowedTools:/.test(l));
  assert.ok(line, `${agent}: no disallowedTools line`);
  return line.replace(/^disallowedTools:/, '').split(',').map((x) => x.trim()).filter(Boolean);
}
function description(agent) {
  const m = frontmatter(agent).match(/^description:\s*"?(.*?)"?\s*$/m);
  assert.ok(m, `${agent}: no description`);
  return m[1];
}

test('every ladder rung denies Skill, so its start carries no skill listing', () => {
  assert.ok(cfg.ladder.length >= 10);
  for (const r of cfg.ladder) {
    assert.ok(denied(r.agent).includes('Skill'), `${r.agent} must deny Skill`);
  }
});

test('the browser variants keep Skill (the browser skills are read before the first browser step) and keep their browser servers', () => {
  const variants = cfg.ladderVariants.filter((v) => v.browser);
  assert.ok(variants.length >= 2);
  for (const v of variants) {
    const d = denied(v.agent);
    assert.ok(!d.includes('Skill'), `${v.agent} keeps Skill`);
    for (const s of ['mcp__Claude_Browser', 'mcp__claude-in-chrome', 'mcp__computer-use']) {
      assert.ok(!d.includes(s), `${v.agent} keeps ${s}`);
    }
  }
});

test('Skill is dropped by the generated policy for every rung and kept only where config keepOn says so', () => {
  assert.deepEqual(cfg.ladderTools.keepOn.Skill, cfg.ladderVariants.filter((v) => v.browser).map((v) => v.agent));
});

test('tools with no use without Skill, and plugin discovery, are dropped from every ladder agent, browser variants included', () => {
  for (const a of [...cfg.ladder, ...cfg.ladderVariants]) {
    for (const t of ['ListSkills', 'SearchSkills', 'ListPlugins', 'SearchPlugins', 'SuggestPluginInstall']) {
      assert.ok(denied(a.agent).includes(t), `${a.agent} drops ${t}`);
    }
  }
});

test('a brief that asks a worker to load a skill is recognised, so the guard does not swap a general-purpose spawn for a rung', async () => {
  const { briefNeedsDroppedTools } = await import('../hooks/lib/context.mjs');
  assert.equal(briefNeedsDroppedTools('Invoke the acme:bus skill, then file a card.').skill, true);
  assert.equal(briefNeedsDroppedTools('load the team-orchestration skill first').skill, true);
  assert.equal(briefNeedsDroppedTools('Use the Skill tool for plugin-authoring.').skill, true);
  assert.equal(briefNeedsDroppedTools('Read C:/x/.claude/skills/run/SKILL.md, then run the app.').skill, false);
  assert.equal(briefNeedsDroppedTools('Edit the recommend skill text and its test.').skill, false);
  assert.equal(briefNeedsDroppedTools('Invoke the `team-orchestration` skill first.').skill, true);
  assert.equal(briefNeedsDroppedTools('Use the team-orchestration skill before briefing.').skill, true);
  assert.equal(briefNeedsDroppedTools('Run Skill(team-orchestration) and follow it.').skill, true);
  assert.equal(briefNeedsDroppedTools('The ac-* workers have no Skill tool, so Read the file.').skill, false);
  assert.equal(briefNeedsDroppedTools('Use the skill listing text as the fixture.').skill, false);
});

test('the self-review block tells a worker with no Skill tool that the text is the whole spawn recipe', () => {
  for (const agent of ['ac-opus-medium', 'ac-opus-high', 'ac-opus-xhigh']) {
    const body = readFileSync(join(PLUGIN_ROOT, 'agents', `${agent}.md`), 'utf8');
    assert.match(body, /you have no Skill tool/, agent);
    assert.match(body, /do not look for the team-orchestration skill/, agent);
  }
});

// --- no account-specific connector id in a shipped file ---------------------

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
// What ships to a user: the plugin manifest, agent and skill text, config, hooks,
// scripts, docs and the top-level readme and changelog. tests/, bench/ and
// evals/ hold fixtures (session ids and the like) and are not shipped text.
const SHIPPED_DIRS = ['agents', 'config', '.claude-plugin', 'hooks', 'scripts', 'skills', 'docs', 'routines', 'shims'];
const SHIPPED_FILES = ['README.md', 'CHANGELOG.md'];
const TEXT_EXT = new Set(['.md', '.json', '.mjs', '.js', '.cjs', '.txt', '.yml', '.yaml', '.sh', '.cmd', '.ps1', '']);

function walk(dir, out) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(extname(n))) out.push(p);
  }
  return out;
}

test('no shipped file carries a UUID (a connector id such as mcp__<uuid> is per-account)', () => {
  const files = [
    ...SHIPPED_DIRS.flatMap((d) => walk(join(PLUGIN_ROOT, d), [])),
    ...SHIPPED_FILES.map((f) => join(PLUGIN_ROOT, f)),
  ];
  assert.ok(files.length > 50, `scanned ${files.length} files`);
  const hits = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => { if (UUID.test(l)) hits.push(`${f.slice(PLUGIN_ROOT.length + 1)}:${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});

test('no ladder disallowedTools entry is account-specific: only built-in names and mcp__<server> with a plain name', () => {
  for (const a of [...cfg.ladder, ...cfg.ladderVariants]) {
    for (const t of denied(a.agent)) {
      assert.match(t, /^(?:[A-Z][A-Za-z]+|mcp__[A-Za-z][A-Za-z0-9_-]*)$/, `${a.agent}: ${t}`);
      assert.doesNotMatch(t, UUID, `${a.agent}: ${t}`);
    }
  }
});

// --- shorter descriptions ----------------------------------------------------

test('ladder descriptions total at most 1250 bytes (1766 before 0.31.11) and each keeps its routing cue', () => {
  let total = 0;
  for (const r of cfg.ladder) {
    const d = description(r.agent);
    total += Buffer.byteLength(d);
    // The rung number and its role are what a lead picks from.
    assert.match(d, new RegExp(`${r.rung}/${cfg.ladder.length}`), `${r.agent}: rung number`);
    assert.ok(d.includes(r.role), `${r.agent}: role`);
  }
  for (const v of cfg.ladderVariants) total += Buffer.byteLength(description(v.agent));
  assert.ok(total <= 1250, `descriptions total ${total} bytes`);
});

// --- worker-facing hook text names scripts by path, not by skill -------------

test('spawn-guard messages name the recommender by absolute path, not a bare relative one', () => {
  const src = readFileSync(join(PLUGIN_ROOT, 'hooks', 'spawn-guard.mjs'), 'utf8');
  // One occurrence is allowed: the fallback when the guard cannot resolve its own location.
  const bare = src.match(/node scripts\/recommend\.mjs/g) || [];
  assert.equal(bare.length, 1, 'only the RECOMMEND_CMD fallback may carry the bare form');
  assert.doesNotMatch(src, /the setup skill/, 'a worker has no Skill tool: name the SKILL.md path');
});
