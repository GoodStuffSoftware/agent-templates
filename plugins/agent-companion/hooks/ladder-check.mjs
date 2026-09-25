// SessionStart — detect when the ladder (config/model-tiers.json's `ladder`,
// the generic ac-* worker definitions under agents/) is broken for THIS
// session, before a spawn fails on it mid-task.
//
// Observed (peer report, 2026-09-24): after /reload-plugins on a desktop
// session — which itself reported success ("6 agents · 20 hooks") —
// `agent-companion:ac-opus-low` and the bare `ac-opus-low` still failed with
// "Agent type not found", and spawn-guard.mjs kept enforcing the OLD
// (0.22.0-era) SPAWNING RULE behaviour even though self-update.mjs reported a
// fresh load. Root cause, confirmed on this machine: a STALE agent-companion
// entry left loaded in the desktop app alongside the new one — this
// machine's own plugin cache holds a dozen+ old version directories under
// .claude/plugins/cache/<marketplace>/agent-companion/ (0.12.0 .. 0.29.1),
// and the desktop app can keep serving hooks from one of them after a reload
// that only refreshed the marketplace metadata, not the loaded process.
//
// Claude Code exposes NO registered-agent-list to a SessionStart hook (this
// is unverified from a hook and stays that way — recorded here so a future
// change to the hook payload shape is what would let this check tighten, not
// a guess). So this hook checks two things it CAN see from disk:
//
//   1. The plugin's own agents/ directory: does it exist, and does every
//      ac-* rung in config/model-tiers.json's `ladder` have a matching file
//      that parses and carries the expected model/effort frontmatter? A
//      broken or missing file here means a spawn WILL fail regardless of
//      what the harness thinks it registered.
//   2. The RUNNING vs INSTALLED version gap: spawn-guard.mjs self-reports its
//      own resolved version on every invocation (hooks/spawn-guard.mjs's
//      reportOwnVersion(), state/spawn-guard-running.json). If that recorded
//      version is older than what installed_plugins.json says is installed
//      for this session, a stale copy is still running NOW — the exact shape
//      of the incident above, and the one thing a reload's own "success"
//      message cannot catch, because that message comes from the reload
//      mechanism, not from asking the hooks themselves what they are running.
//
// Quiet when both checks are clean (no self-report yet counts as clean — it
// means spawn-guard.mjs has not run yet this session, not that anything is
// wrong). Loud, with the concrete recovery step, when either looks wrong.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  readStdin, opt, passthrough, stateFile, readJson, claudeDir, modelTiers,
} from './lib/context.mjs';

// The RECOVERY step, operator-confirmed on this machine (2026-09-24): a
// second /reload-plugins, run after the plugin install had actually
// finished, DID pick up the ladder ("16 agents · 21 hooks") once the stale
// desktop-app entry was removed. Named exactly once so both problems below
// point at the identical instruction — a caller acting on this should never
// have to reconcile two slightly different phrasings.
const RECOVERY = 'remove the stale agent-companion entry in the desktop plugin manager, then /reload-plugins, ' +
  'then verify with a trivial ladder spawn. If that still fails, start a fresh session.';

function runningPluginRoot() {
  const here = fileURLToPath(import.meta.url); // .../hooks/ladder-check.mjs
  return join(dirname(here), '..');
}

function readPluginJson(root) {
  try {
    const pj = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    return (pj && pj.name && pj.version) ? pj : null;
  } catch {
    return null;
  }
}

// Parse one agent definition's frontmatter, same shape as
// hooks/lib/context.mjs's agentDefinition() and scripts/routing-table.mjs's
// own reader — kept local rather than imported so this hook has no
// dependency beyond the plain file it is checking.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

// Registration itself is unverifiable from a hook (see header) UNLESS a
// future harness payload starts exposing what it actually loaded — checked
// defensively under a few plausible field names so this tightens for free
// the day that becomes true, without needing to guess the exact shape now.
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
    }
  }
  return { ok: problems.length === 0, problems };
}

// --- Version self-check --------------------------------------------------

function installedPluginsPath() {
  return join(claudeDir(), 'plugins', 'installed_plugins.json');
}
function loadInstalledPlugins() {
  try {
    const j = JSON.parse(readFileSync(installedPluginsPath(), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}
function normalizePath(s) {
  let n = String(s || '').replace(/\\/g, '/');
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
function cwdUnder(cwd, projectPath) {
  const a = normalizePath(cwd);
  const b = normalizePath(projectPath);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`);
}

// Every installed_plugins.json entry for this plugin's base name, across
// EVERY scope — not just the one effective for this session — because the
// warning must be able to LIST more than one visible install when there is
// one, not silently collapse to the winner.
function pluginEntries(installedJson, baseName) {
  const out = [];
  const table = installedJson && (installedJson.plugins || installedJson);
  if (!table || typeof table !== 'object') return out;
  for (const key of Object.keys(table)) {
    if (key.split('@')[0] !== baseName) continue;
    const raw = table[key];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const e of list) if (e && typeof e === 'object' && e.version) out.push(e);
  }
  return out;
}
function effectiveEntry(entries, cwd) {
  let userEntry = null;
  let projectEntry = null;
  for (const e of entries) {
    if (e.scope === 'user') {
      if (!userEntry) userEntry = e;
    } else if (e.projectPath && cwdUnder(cwd, e.projectPath)) {
      if (!projectEntry || String(e.projectPath).length > String(projectEntry.projectPath).length) projectEntry = e;
    }
  }
  return projectEntry || userEntry || entries[0] || null;
}

// Plugin cache version directories actually on disk
// (.claude/plugins/cache/<marketplace>/<plugin>/<version>/) — separate from
// installed_plugins.json's own entries: a stale cache dir can sit there
// un-cleaned long after installed_plugins.json itself only names the current
// version, which is exactly the shape of the incident this hook exists to
// surface (this machine measured 16 such directories for agent-companion,
// spanning 0.8.3 through 0.29.1).
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
    const pluginDir = join(cacheRoot, mp, baseName);
    let versions = [];
    try {
      versions = readdirSync(pluginDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const v of versions) out.push(`${mp}/${baseName}@${v}`);
  }
  return out.sort();
}

// null = nothing to report (no self-report yet, installed_plugins.json
// unreadable, or versions match — every one of these is "stay silent", not
// "problem"). An object = a real, nameable mismatch.
function checkRunningVsInstalled(pj, cwd) {
  const report = readJson(stateFile('spawn-guard-running.json'), null);
  if (!report || !report.version) return null; // spawn-guard.mjs has not run yet this session
  const installedJson = loadInstalledPlugins();
  if (!installedJson) return null;
  const baseName = String(pj.name).split('@')[0];
  const entries = pluginEntries(installedJson, baseName);
  if (!entries.length) return null;
  const effective = effectiveEntry(entries, cwd);
  if (!effective || !effective.version || effective.version === report.version) return null;

  const distinct = [...new Map(entries.map((e) => [`${e.scope || '?'}@${e.version}`, e])).values()];
  return {
    runningVersion: report.version,
    installedVersion: effective.version,
    distinctEntries: distinct,
    cacheDirs: cacheVersionDirs(baseName),
  };
}

function buildLadderProblemMessage(problems) {
  return 'agent-companion: the ladder looks broken for this session — ' +
    `${problems.join('; ')}. Whether the harness actually REGISTERED these agents cannot be verified from a ` +
    `hook (Claude Code exposes no registered-agent list to SessionStart); this only confirms what is on disk. ` +
    `Recovery: ${RECOVERY}`;
}

function buildVersionMessage(v) {
  let msg = `agent-companion: spawn-guard.mjs last reported running ${v.runningVersion}, but installed_plugins.json ` +
    `says ${v.installedVersion} is installed for this session — a stale copy may still be enforcing routing right ` +
    `now even though a reload reported success.`;
  const moreThanOne = v.distinctEntries.length > 1 || v.cacheDirs.length > 1;
  if (moreThanOne) {
    const entryList = v.distinctEntries.map((e) => `${e.scope || '?'}@${e.version}`).join(', ');
    msg += ` More than one agent-companion install/cache dir is visible — installed_plugins.json: ${entryList}`;
    if (v.cacheDirs.length) {
      const shown = v.cacheDirs.slice(0, 8);
      const extra = v.cacheDirs.length > 8 ? `, +${v.cacheDirs.length - 8} more` : '';
      msg += `; plugin cache: ${shown.join(', ')}${extra}`;
    }
    msg += '.';
  }
  msg += ` Recovery: ${RECOVERY}`;
  return msg;
}

try {
  const p = readStdin();
  if (!opt('ladder_check', true)) passthrough();

  const root = runningPluginRoot();
  const pj = readPluginJson(root);

  const ladder = checkLadderFiles(root, p);
  const versionIssue = pj ? checkRunningVsInstalled(pj, p.cwd || process.cwd()) : null;

  if (ladder.ok && !versionIssue) passthrough(); // both clean: say nothing

  const parts = [];
  if (!ladder.ok) parts.push(buildLadderProblemMessage(ladder.problems));
  if (versionIssue) parts.push(buildVersionMessage(versionIssue));

  process.stdout.write(JSON.stringify({ systemMessage: parts.join('\n\n') }));
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
