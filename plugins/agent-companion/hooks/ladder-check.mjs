// SessionStart (and SessionEnd, only to record an in-process /resume) — detect when the ladder (config/model-tiers.json's `ladder`,
// the generic ac-* worker definitions under agents/) is broken for THIS
// session, before a spawn fails on it mid-task.
//
// Observed (peer report, 2026-09-24): after /reload-plugins on a desktop
// session, `agent-companion:ac-opus-low` and the bare `ac-opus-low` failed
// with "Agent type not found". The hook and agent counts the reload printed
// show the session had loaded ONLY a stale 0.22.0 copy of this plugin (no
// agents/ folder at all), not the installed 0.29.1 one. A stale-only
// session runs only the stale copy's hooks, so nothing in the new copy can
// see it from inside that session. That case is caught ACROSS sessions
// instead: spawn-guard.mjs stamps its own version and install scope into
// every spawns.jsonl row, and the daily scout (scripts/detect.mjs,
// stale_copy_loaded) flags rows guarded by a version older than what was
// installed for that scope.
//
// Claude Code exposes no registered-agent list to a SessionStart hook, so
// this hook checks what it CAN see from disk:
//
//   1. The plugin's own agents/ directory: does every rung in the config's
//      `ladder` have a matching file that parses and carries the expected
//      model/effort frontmatter? A broken or missing file means a spawn WILL
//      fail, whatever the harness registered.
//   2. Whether THIS copy is an older copy than the install that applies to
//      this session's cwd: an orphaned cache copy (under the plugin cache
//      but not the installPath of any entry) or a copy loaded from outside
//      the cache that is not a git work tree (copySource "bundle", e.g. an
//      app-extracted desktop bundle), whose version is BELOW the applicable
//      entry. Directional (a newer copy is never "stale"), scoped to the
//      applicable install, never true of a source checkout, and judged only
//      when this process just loaded it: source startup, or a resume in a
//      FRESH process (noteProcessLoad: an in-process /resume keeps the copy
//      the process loaded before any update, which is not a stale install;
//      it is told apart by CLAUDE_PID plus the SessionEnd "resume" the same
//      process raises just before, which this hook records too; a resume
//      that cannot be tied that way is treated as fresh, and with no
//      CLAUDE_PID a resume is not judged at all). /clear and
//      compaction are never judged. This is the in-session half of the
//      version check; it catches a stale copy of this version or later,
//      which 0.22.0 is not.
//
// Quiet when both checks are clean. Loud, with the concrete recovery step,
// when either is not.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import {
  readStdin, opt, passthrough, claudeDir, modelTiers,
  readInstalledPlugins, pluginEntries, effectiveEntry, pathUnder, versionBelow, copySource,
  noteProcessLoad, noteProcessEnd, LOAD_SETTLE_MS,
} from './lib/context.mjs';

// The recovery for a stale loaded copy, operator-confirmed on this machine
// (2026-09-24). Named once so every message quotes it identically.
const STALE_COPY_RECOVERY = 'remove the stale agent-companion entry in the desktop plugin manager, then ' +
  '/reload-plugins, then verify with a trivial ladder spawn; start a fresh session if that still fails.';
// The recovery for missing or broken agent files in the loaded copy: the
// files themselves are wrong, so the copy needs replacing.
const BROKEN_FILES_RECOVERY = 'update or reinstall the plugin (claude plugin update agent-companion, or remove ' +
  'and re-add it), then /reload-plugins, then verify with a trivial ladder spawn; start a fresh session if that ' +
  'still fails.';

// A copy whose install entry changed in the last few minutes may be one this
// very process started loading just before the update wrote the entry
// (LOAD_SETTLE_MS, shared with the scout's stale_copy_loaded).

function runningPluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function readPluginJson(root) {
  try {
    const pj = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    return (pj && typeof pj.name === 'string' && typeof pj.version === 'string') ? pj : null;
  } catch {
    return null;
  }
}

// Frontmatter scalars, with surrounding YAML quotes stripped.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return fm;
}

// Checked under a few plausible field names so this tightens for free the
// day a harness payload exposes what it actually registered.
function harnessRegisteredAgentNames(p) {
  const candidates = [p?.agents, p?.available_agents, p?.registered_agents];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return new Set(c.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean));
    }
  }
  return null; // not exposed: unverifiable from here
}

function checkLadderFiles(root, p) {
  const problems = [];
  const agentsDir = join(root, 'agents');
  if (!existsSync(agentsDir)) {
    return { ok: false, problems: [`agents/ is missing at ${agentsDir}`] };
  }
  let cfg;
  try { cfg = modelTiers(); } catch (e) { return { ok: false, problems: [`config/model-tiers.json unreadable: ${e.message}`] }; }
  const ladder = Array.isArray(cfg.ladder) ? cfg.ladder : [];
  let files;
  try { files = new Set(readdirSync(agentsDir)); } catch (e) { return { ok: false, problems: [`agents/ unreadable: ${e.message}`] }; }

  const registered = harnessRegisteredAgentNames(p);
  let notRegistered = false;

  for (const r of ladder) {
    const file = `${r.agent}.md`;
    if (!files.has(file)) { problems.push(`agents/${file} is missing (rung ${r.rung})`); continue; }
    let text;
    try { text = readFileSync(join(agentsDir, file), 'utf8'); } catch (e) { problems.push(`agents/${file} unreadable: ${e.message}`); continue; }
    const fm = parseFrontmatter(text);
    if (!fm) { problems.push(`agents/${file} has no parseable frontmatter`); continue; }
    if (fm.model !== r.model) problems.push(`agents/${file} frontmatter model "${fm.model || '(none)'}" does not match ladder rung ${r.rung} ("${r.model}")`);
    if ((fm.effort || null) !== (r.effort || null)) {
      problems.push(`agents/${file} frontmatter effort "${fm.effort || '(none)'}" does not match ladder rung ${r.rung} ("${r.effort || '(none)'}")`);
    }
    if (registered && !registered.has(r.agent) && !registered.has(`agent-companion:${r.agent}`)) {
      problems.push(`${r.agent} is not in the harness's own registered-agent list for this session`);
      notRegistered = true;
    }
  }
  return { ok: problems.length === 0, problems, notRegistered };
}

// --- In-session stale-copy check ------------------------------------------

// Plugin cache version directories on disk
// (.claude/plugins/cache/<marketplace>/<plugin>/<version>/), listed when more
// than one copy is visible.
function cacheVersionDirs(baseName) {
  const cacheRoot = join(claudeDir(), 'plugins', 'cache');
  const out = [];
  let marketplaces = [];
  try {
    marketplaces = readdirSync(cacheRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const mp of marketplaces) {
    let versions = [];
    try {
      versions = readdirSync(join(cacheRoot, mp, baseName), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const v of versions) out.push(`${mp}/${baseName}@${v}`);
  }
  return out.sort();
}

// null = nothing to report. An object = this process just loaded an orphaned
// cache copy, or a non-checkout copy from outside the cache, older than the
// install that applies to its cwd.
function checkStaleCopy(root, pj, p, nowMs, load) {
  const source = typeof p.source === 'string' ? p.source : '';
  if (source !== 'startup' && source !== 'resume') return null; // same process as before: not a stale install
  if (source === 'resume' && !(load && load.fresh === true)) return null; // in-process /resume, or unknowable
  const where = copySource(root, claudeDir());
  if (where === 'checkout') return null; // a git work tree is the operator's own tree
  const entries = pluginEntries(readInstalledPlugins(claudeDir()), pj.name);
  if (!entries.length) return null;
  if (entries.some((e) => e.installPath && pathUnder(root, e.installPath))) return null; // an installed copy
  const eff = effectiveEntry(entries, p.cwd || process.cwd());
  if (!eff || !versionBelow(pj.version, eff.version)) return null; // directional: never newer, never equal
  const updatedMs = Date.parse(eff.lastUpdated || '');
  if (Number.isFinite(updatedMs) && nowMs - updatedMs < LOAD_SETTLE_MS) return null; // an update landing right now
  return {
    where,
    runningVersion: pj.version,
    installedVersion: eff.version,
    installedScope: eff.scope || 'user',
    entries,
    cacheDirs: cacheVersionDirs(pj.name),
  };
}

function buildLadderProblemMessage(ladder) {
  return 'agent-companion: the ladder looks broken for this session — ' +
    `${ladder.problems.join('; ')}. Whether the harness actually REGISTERED these agents cannot be verified from a ` +
    'hook (Claude Code exposes no registered-agent list to SessionStart); this only confirms what is on disk. ' +
    `Recovery: ${ladder.notRegistered && ladder.problems.every((x) => /registered-agent list/.test(x)) ? STALE_COPY_RECOVERY : BROKEN_FILES_RECOVERY}`;
}

function buildStaleCopyMessage(v) {
  const what = v.where === 'bundle'
    ? `a copy of the plugin from outside the plugin cache (${v.runningVersion}; for example a desktop app bundle) that is older`
    : `an older cached copy of the plugin (${v.runningVersion})`;
  let msg = `agent-companion: this session loaded ${what} than the ` +
    `one installed for it (${v.installedVersion}, ${v.installedScope} scope) — the stale copy's guards and agent ` +
    'roster are the ones running now.';
  const distinct = [...new Set(v.entries.map((e) => `${e.scope || 'user'}@${e.version}`))];
  if (distinct.length > 1 || v.cacheDirs.length > 1) {
    msg += ` More than one agent-companion install/cache dir is visible — installed_plugins.json: ${distinct.join(', ')}`;
    if (v.cacheDirs.length) {
      const shown = v.cacheDirs.slice(0, 8);
      const extra = v.cacheDirs.length > 8 ? `, +${v.cacheDirs.length - 8} more` : '';
      msg += `; plugin cache: ${shown.join(', ')}${extra}`;
    }
    msg += '.';
  }
  return `${msg} Recovery: ${STALE_COPY_RECOVERY}`;
}

try {
  const p = readStdin();
  // Recorded before the option check: self-update.mjs and the spawn guard
  // read the same per-process record to tell a fresh resume from an
  // in-process /resume. SessionEnd "resume" is the in-process /resume's own
  // announcement (noteProcessEnd); /clear and compaction move the record to
  // the process's new session id.
  if (p.hook_event_name === 'SessionEnd') {
    try { noteProcessEnd(p.reason, p.session_id || 'unknown'); } catch { /* fail open */ }
    passthrough();
  }
  let load = null;
  if (typeof p.source === 'string' && p.source) {
    try { load = noteProcessLoad(p.source, p.session_id || 'unknown'); } catch { load = null; }
  }
  if (!opt('ladder_check', true)) passthrough();

  const root = runningPluginRoot();
  const pj = readPluginJson(root);
  const fake = process.env.AGENT_COMPANION_FAKE_NOW;
  const nowMs = fake ? Date.parse(fake) : Date.now();

  const ladder = checkLadderFiles(root, p);
  let stale = null;
  try { stale = pj ? checkStaleCopy(root, pj, p, nowMs, load) : null; } catch { stale = null; }

  if (ladder.ok && !stale) passthrough(); // both clean: say nothing

  const parts = [];
  if (!ladder.ok) parts.push(buildLadderProblemMessage(ladder));
  if (stale) parts.push(buildStaleCopyMessage(stale));

  process.stdout.write(JSON.stringify({ systemMessage: parts.join('\n\n') }));
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
