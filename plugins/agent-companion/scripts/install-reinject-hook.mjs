#!/usr/bin/env node
// install-reinject-hook.mjs — installs the OPTIONAL compaction re-inject hook
// (shims/global-hooks/agent-companion-reinject.mjs) as a user-level
// SessionStart entry with matcher "compact". Never run automatically: `/ac
// setup` offers it and runs this only after the operator says yes.
//
// Usage:
//   node install-reinject-hook.mjs [--dry-run] [--file <tpl>]... [--max-chars <n>] [--force]
//   node install-reinject-hook.mjs --uninstall [--dry-run]
//   node install-reinject-hook.mjs --status
//   (--settings <path> --hooks-dir <path> replace the ~/.claude defaults)
//
// Detect-existing (by NAME only; user settings.json and settings.local.json,
// not project-level .claude/settings*.json): if either already has a SessionStart entry that
// would fire on compaction (matcher empty, "*", or naming "compact") whose
// command/args mention "reinject", "re-inject", "SESSION-STATE" or
// "HANDOFF" and is NOT ours, install refuses (exit 0, nothing written) so
// the state is not injected twice. --force installs anyway.
//
// Idempotent; settings.json is backed up before any write; nothing is
// written if anything fails.

import {
  readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, unlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir } from '../hooks/lib/context.mjs';
import { backupFile as backup } from './lib/backup-file.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const vals = (n) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));

const DRY_RUN = has('--dry-run');
const UNINSTALL = has('--uninstall');
const STATUS = has('--status');
const FORCE = has('--force');

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHIM_SOURCE = join(pluginRoot, 'shims', 'global-hooks', 'agent-companion-reinject.mjs');
const SHIM_FILENAME = 'agent-companion-reinject.mjs';
const settingsPath = resolve(val('--settings') || join(claudeDir(), 'settings.json'));
const hooksDir = resolve(val('--hooks-dir') || join(claudeDir(), 'hooks'));
const shimDest = join(hooksDir, SHIM_FILENAME);
const EVENT = 'SessionStart';
const MATCHER = 'compact';
const STATUS_MESSAGE = 'Re-injecting saved state after compaction (agent-companion)';
const LOOKALIKE = /re-?inject|SESSION-STATE|HANDOFF/i;

function normPath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

const hookText = (h) => [h?.command, ...(Array.isArray(h?.args) ? h.args : [])].filter(Boolean).join(' ');
const isOurs = (h) => normPath(hookText(h)).includes(normPath(shimDest))
  || hookText(h).includes(SHIM_FILENAME);
const firesOnCompact = (g) => {
  const m = g?.matcher;
  if (m === undefined || m === '' || m === '*') return true;
  try { return new RegExp(`^(?:${m})$`).test(MATCHER); } catch { return String(m).includes(MATCHER); }
};

function scan(settings) {
  const groups = Array.isArray(settings?.hooks?.[EVENT]) ? settings.hooks[EVENT] : [];
  let ours = false; const others = [];
  for (const g of groups) {
    for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      if (isOurs(h)) ours = true;
      else if (firesOnCompact(g) && LOOKALIKE.test(hookText(h))) others.push(hookText(h));
    }
  }
  return { ours, others };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Returns a problem string when the settings shape is one this installer
// must not rewrite (it would report success without installing, or drop the
// user's value), else ''.
function shapeProblem(settings) {
  if (!isObj(settings)) return 'the top level is not a JSON object';
  if (settings.hooks !== undefined && !isObj(settings.hooks)) return '"hooks" is not an object';
  if (settings.hooks?.[EVENT] !== undefined && !Array.isArray(settings.hooks[EVENT])) return `"hooks.${EVENT}" is not an array`;
  return '';
}

function loadSettings() {
  return existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
}
const localPath = join(dirname(settingsPath), 'settings.local.json');
function localOthers() {
  try {
    if (!existsSync(localPath)) return [];
    const l = JSON.parse(readFileSync(localPath, 'utf8'));
    return isObj(l) && !shapeProblem(l) ? scan(l).others.map((o) => `${o} (settings.local.json)`) : [];
  } catch { return []; }
}
function write(next) {
  JSON.parse(JSON.stringify(next));
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
}

function hookArgs() {
  const args = [shimDest];
  for (const f of vals('--file')) args.push('--file', f);
  const mc = val('--max-chars');
  if (mc) args.push('--max-chars', String(mc));
  return args;
}

try {
  let settings;
  try { settings = loadSettings(); } catch (e) {
    console.error(`install-reinject-hook: cannot parse ${settingsPath}: ${e.message}; nothing written.`);
    process.exit(1);
  }
  const problem = shapeProblem(settings);
  if (problem) {
    console.error(`install-reinject-hook: ${settingsPath}: ${problem}; refusing to rewrite it, nothing written.`);
    process.exit(1);
  }
  const scanned = scan(settings);
  const ours = scanned.ours;
  const others = [...scanned.others, ...localOthers()];

  if (STATUS) {
    const state = !ours ? 'not installed'
      : existsSync(shimDest) ? 'installed'
        : `settings entry present but hook file missing (${shimDest}); re-run the installer or --uninstall`;
    console.log(`install-reinject-hook: ${state}${others.length ? `; equivalent hook(s) present: ${others.join(' | ')}` : ''}`);
    process.exit(0);
  }

  if (UNINSTALL) {
    const shimExists = existsSync(shimDest);
    if (!ours && !shimExists) { console.log('install-reinject-hook: nothing to uninstall.'); process.exit(0); }
    console.log(`install-reinject-hook --uninstall: plan\n  ${EVENT} entry: ${ours ? 'remove' : 'not present'}\n  hook file: ${shimExists ? `remove ${shimDest}` : 'not present'}`);
    if (DRY_RUN) { console.log('install-reinject-hook: dry run — nothing changed.'); process.exit(0); }
    if (ours) {
      const next = JSON.parse(JSON.stringify(settings));
      next.hooks[EVENT] = next.hooks[EVENT]
        .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
        .filter((g) => g.hooks.length > 0);
      if (next.hooks[EVENT].length === 0) {
        delete next.hooks[EVENT];
        // We emptied it, so an empty "hooks" left behind is ours to remove.
        if (Object.keys(next.hooks).length === 0) delete next.hooks;
      }
      const b = backup(settingsPath);
      write(next);
      if (b) console.log(`install-reinject-hook: settings backed up to ${b}.`);
    }
    if (shimExists) unlinkSync(shimDest);
    console.log('install-reinject-hook: uninstalled.');
    process.exit(0);
  }

  // --- install ---
  if (others.length && !FORCE) {
    console.log(`install-reinject-hook: an equivalent compaction re-inject hook is already configured (${others.join(' | ')}); not installing a second one (it would inject twice). Use --force to install anyway.`);
    process.exit(0);
  }
  const shimPlan = !existsSync(shimDest) ? 'create'
    : readFileSync(shimDest, 'utf8') === readFileSync(SHIM_SOURCE, 'utf8') ? 'none' : 'update';
  console.log(`install-reinject-hook: plan\n  hook file: ${shimPlan === 'none' ? `up to date at ${shimDest}` : `${shimPlan} ${shimDest}`}\n  ${EVENT} (matcher "${MATCHER}") entry: ${ours ? 'already present' : 'add'}`);
  if (ours && shimPlan === 'none') { console.log('install-reinject-hook: already installed and up to date.'); process.exit(0); }
  if (DRY_RUN) { console.log('install-reinject-hook: dry run — nothing changed.'); process.exit(0); }
  if (shimPlan !== 'none') { mkdirSync(hooksDir, { recursive: true }); copyFileSync(SHIM_SOURCE, shimDest); }
  if (!ours) {
    const next = JSON.parse(JSON.stringify(settings));
    next.hooks = next.hooks || {};
    next.hooks[EVENT] = Array.isArray(next.hooks[EVENT]) ? next.hooks[EVENT] : [];
    next.hooks[EVENT].push({
      matcher: MATCHER,
      hooks: [{ type: 'command', command: 'node', args: hookArgs(), timeout: 10, statusMessage: STATUS_MESSAGE }],
    });
    const b = backup(settingsPath);
    mkdirSync(dirname(settingsPath), { recursive: true });
    write(next);
    if (b) console.log(`install-reinject-hook: settings backed up to ${b}.`);
  }
  console.log('install-reinject-hook: installed.');
  process.exit(0);
} catch (e) {
  console.error(`install-reinject-hook: aborted (${e.message})`);
  process.exit(1);
}
