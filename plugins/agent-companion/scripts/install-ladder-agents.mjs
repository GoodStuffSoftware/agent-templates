#!/usr/bin/env node
// install-ladder-agents.mjs — DOCUMENTED FALLBACK, never run automatically.
//
// Observed (peer report, 2026-09-24): plugin-scoped agent definitions
// (agents/ac-*.md, namespaced agent-companion:ac-* when spawned from
// outside this repo) sometimes fail to register — "Agent type not found" —
// even right after a /reload-plugins that reported success, because a stale
// plugin-cache entry can keep serving hooks (and, it turns out, the agent
// roster) from an old install path. hooks/ladder-check.mjs (SessionStart)
// detects the two symptoms it can see from a hook; THIS script is the
// recovery for the harness's own registration path, not for that: copying
// the ladder's ac-*.md files to USER-LEVEL agent definitions
// (~/.claude/agents/), which Claude Code's own docs describe as a different,
// user-scoped registration path from a plugin's own agents/ directory. If
// plugin registration is broken but user-level registration is not, a
// user-level copy spawns where the plugin-scoped one would not.
//
// UNVERIFIED (recorded here on purpose, not glossed over): whether a
// user-level agent definition actually registers MID-SESSION (i.e. without
// a fresh session) is NOT confirmed by this track. Test that separately
// before relying on it as a live fix; this script only makes the files
// exist in the right place.
//
// SAFETY CONTRACT — enforced by this script, not just documented:
//   - The DEFAULT action (no flags, or --dry-run) is a PLAN ONLY. Nothing is
//     ever written without --yes on the command line. There is no prompt to
//     bypass this from inside a skill or a hook — --yes is a human at a
//     terminal, on purpose.
//   - A target file this script did not itself install (not in the manifest,
//     or present with content that no longer matches what the manifest
//     recorded) is a NAME COLLISION with something the operator or another
//     tool put there — it is always SKIPPED, never overwritten, listed
//     separately in the plan.
//   - Every file this script writes is recorded in a manifest
//     (~/.claude/agents/.agent-companion-ladder-manifest.json: {file:
//     {sha256, installedAt, sourceVersion}}), so a later run (update) can
//     tell "safe to refresh" (manifest hash still matches what's on disk)
//     from "operator edited this since" (skip), and --uninstall can tell
//     "this script put it there" (safe to remove) from "something else did"
//     (never touched).
//
// Usage:
//   node install-ladder-agents.mjs                 # plan only, writes nothing
//   node install-ladder-agents.mjs --yes            # copy/update per the plan
//   node install-ladder-agents.mjs --uninstall           # plan the removal
//   node install-ladder-agents.mjs --uninstall --yes     # remove manifest-tracked files
//   node install-ladder-agents.mjs --agents-dir <path>   # point somewhere other than ~/.claude/agents (tests)

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir, modelTiers } from '../hooks/lib/context.mjs';

// Strict argument parsing: an unknown flag, or an --agents-dir with no value
// (or with another flag where its value should be), is an error. A loose
// parser once took `--agents-dir --yes` as a folder named "--yes" and still
// honoured --yes, writing the ladder there.
function usageError(msg) {
  console.error(`install-ladder-agents: ${msg}`);
  console.error('usage: install-ladder-agents.mjs [--uninstall] [--yes | --dry-run] [--agents-dir <path>]');
  process.exit(2);
}
function parseArgs(args) {
  const out = { yes: false, uninstall: false, dryRun: false, agentsDir: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--yes') out.yes = true;
    else if (a === '--uninstall') out.uninstall = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--agents-dir' || a.startsWith('--agents-dir=')) {
      if (out.agentsDir !== null) usageError('--agents-dir given more than once');
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
      if (!a.includes('=')) i += 1;
      if (typeof v !== 'string' || !v.trim() || v.startsWith('-')) usageError('--agents-dir needs a path value');
      out.agentsDir = v;
    } else usageError(`unknown argument "${a}"`);
  }
  if (out.yes && out.dryRun) usageError('--yes and --dry-run contradict each other');
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
// How many files an install run had written when it stopped (the catch at
// the bottom reports it; a failure part-way must not claim nothing changed).
const WRITE_STATE = { writtenCount: 0 };

const YES = ARGS.yes && !ARGS.dryRun;
const UNINSTALL = ARGS.uninstall;

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceAgentsDir = join(pluginRoot, 'agents');
const targetAgentsDir = resolve(ARGS.agentsDir || join(claudeDir(), 'agents'));
const manifestPath = join(targetAgentsDir, '.agent-companion-ladder-manifest.json');

// A manifest key is trusted only when it is a plain ladder-shaped file name
// that lands directly inside the agents dir: no "..", no separator, not
// absolute. The manifest is a file on disk that anything can edit, so an
// entry like "../settings.json" with a matching hash must never become a
// delete outside the agents dir.
function safeManifestName(file) {
  if (typeof file !== 'string' || !file) return false;
  if (file.includes('/') || file.includes('\\') || file.includes('..') || isAbsolute(file)) return false;
  if (basename(file) !== file || !/^ac-[A-Za-z0-9._-]+\.md$/.test(file)) return false;
  return dirname(resolve(targetAgentsDir, file)) === targetAgentsDir;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readPluginVersion() {
  try {
    const pj = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    return pj?.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function loadManifest() {
  try {
    const j = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch {
    return {};
  }
}

function ladderFiles() {
  let cfg;
  try { cfg = modelTiers(); } catch (e) {
    console.error(`install-ladder-agents: config/model-tiers.json unreadable: ${e.message}`);
    process.exit(1);
  }
  return (Array.isArray(cfg.ladder) ? cfg.ladder : []).map((r) => `${r?.agent}.md`).filter(safeManifestName);
}

// One of: 'create' (target absent), 'update' (target present, manifest hash
// matches current content — safe to refresh), 'up-to-date' (target content
// already matches the source), 'collision' (target present, NOT tracked by
// this manifest, or tracked but its content no longer matches what was
// recorded — an operator or something else changed it since; never touched).
function planFile(file, manifest) {
  const src = readFileSync(join(sourceAgentsDir, file), 'utf8');
  const srcHash = sha256(src);
  const dest = join(targetAgentsDir, file);
  if (!existsSync(dest)) return { file, action: 'create', src, srcHash };
  const current = readFileSync(dest, 'utf8');
  if (current === src) return { file, action: 'up-to-date', src, srcHash };
  const tracked = manifest[file];
  if (tracked && tracked.sha256 === sha256(current)) {
    return { file, action: 'update', src, srcHash };
  }
  return { file, action: 'collision', src, srcHash };
}

function printPlan(plan) {
  console.log(`install-ladder-agents: plan (target: ${targetAgentsDir})`);
  for (const p of plan) {
    const label = {
      create: 'CREATE', update: 'UPDATE (manifest-tracked, unmodified since install)',
      'up-to-date': 'up to date', collision: 'SKIP (name collision — not installed by this script, or hand-edited since)',
    }[p.action];
    console.log(`  ${p.file}: ${label}`);
  }
  const collisions = plan.filter((p) => p.action === 'collision');
  if (collisions.length) {
    console.log('');
    console.log(`${collisions.length} file(s) will be SKIPPED — remove or rename them yourself first if you want this`);
    console.log('script to manage them, or leave them: a name collision is never overwritten automatically.');
  }
}

try {
  if (UNINSTALL) {
    const manifest = loadManifest();
    const entries = Object.entries(manifest);
    if (!entries.length) {
      console.log(`install-ladder-agents --uninstall: no manifest at ${manifestPath} — nothing to remove.`);
      process.exit(0);
    }
    console.log('install-ladder-agents --uninstall: plan');
    const removable = [];
    for (const [file, rec] of entries) {
      if (!safeManifestName(file)) {
        console.log(`  ${JSON.stringify(file)}: REFUSED (not a plain ac-*.md name inside ${targetAgentsDir} — never touched)`);
        continue;
      }
      if (!rec || typeof rec.sha256 !== 'string') { console.log(`  ${file}: SKIP (manifest entry has no hash)`); continue; }
      const dest = join(targetAgentsDir, file);
      if (!existsSync(dest)) { console.log(`  ${file}: already absent`); continue; }
      const current = readFileSync(dest, 'utf8');
      if (sha256(current) === rec.sha256) {
        console.log(`  ${file}: REMOVE (unmodified since install)`);
        removable.push(file);
      } else {
        console.log(`  ${file}: SKIP (hand-edited since install — not removed)`);
      }
    }
    if (!removable.length) {
      console.log('install-ladder-agents: nothing safe to remove.');
      process.exit(0);
    }
    if (!YES) {
      console.log('\ninstall-ladder-agents: plan only — re-run with --yes to actually remove the files above.');
      process.exit(0);
    }
    for (const file of removable) unlinkSync(join(targetAgentsDir, file));
    const remaining = Object.fromEntries(entries.filter(([f]) => !removable.includes(f)));
    if (Object.keys(remaining).length) writeFileSync(manifestPath, JSON.stringify(remaining, null, 2));
    else { try { unlinkSync(manifestPath); } catch { /* already gone */ } }
    console.log(`install-ladder-agents: removed ${removable.length} file(s).`);
    process.exit(0);
  }

  // --- install / update --------------------------------------------------
  const manifest = loadManifest();
  const files = ladderFiles();
  const plan = files.map((f) => planFile(f, manifest));
  printPlan(plan);

  const toWrite = plan.filter((p) => p.action === 'create' || p.action === 'update');
  if (!toWrite.length) {
    console.log('\ninstall-ladder-agents: nothing to do (all up to date, or every difference is a collision).');
    process.exit(0);
  }
  if (!YES) {
    console.log('\ninstall-ladder-agents: plan only — nothing written. Re-run with --yes to copy the files above to');
    console.log(`${targetAgentsDir}. This is a documented FALLBACK for when plugin-scoped agent registration`);
    console.log('fails (see hooks/ladder-check.mjs); whether a user-level definition registers MID-SESSION is');
    console.log('UNVERIFIED — test with a trivial spawn after copying, in a fresh session if it does not work at once.');
    process.exit(0);
  }

  mkdirSync(targetAgentsDir, { recursive: true });
  const version = readPluginVersion();
  const nextManifest = { ...manifest };
  const written = [];
  try {
    for (const p of toWrite) {
      writeFileSync(join(targetAgentsDir, p.file), p.src);
      written.push(p.file);
      WRITE_STATE.writtenCount = written.length;
      nextManifest[p.file] = { sha256: p.srcHash, installedAt: new Date().toISOString(), sourceVersion: version };
    }
  } finally {
    // Whatever was written is recorded, even when a later write failed, so
    // update and uninstall still recognise those files as this script's own.
    if (written.length) writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2));
  }
  console.log(`\ninstall-ladder-agents: wrote ${toWrite.length} file(s) to ${targetAgentsDir}.`);
  console.log('Registration mid-session is UNVERIFIED. A user-level copy registers under its BARE name, so check it');
  console.log('with a trivial spawn of the bare ac-opus-low (agent-companion:ac-opus-low exercises the plugin copy');
  console.log('instead); start a fresh session if it does not resolve.');
  process.exit(0);
} catch (e) {
  console.error(`install-ladder-agents: aborted (${e.message}).` +
    (WRITE_STATE.writtenCount ? ` ${WRITE_STATE.writtenCount} file(s) were written before the failure and are recorded in the manifest.` : ' Nothing was written.'));
  process.exit(1);
}
