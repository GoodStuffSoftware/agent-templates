#!/usr/bin/env node
// install-global-hooks.mjs — installs the agent-companion staleness shim as a
// USER-LEVEL SessionStart + UserPromptSubmit hook, so the stale-plugin notice
// runs from a fixed path in every session instead of from inside whichever
// plugin-cache folder a session happened to load at startup — the path that
// can itself go stale mid-session. See shims/global-hooks/agent-companion-
// staleness.mjs for the full mechanism, and README.md's "Global hook" section
// for the one-line why.
//
// Usage:
//   node install-global-hooks.mjs [--dry-run]
//   node install-global-hooks.mjs --uninstall [--dry-run]
//   node install-global-hooks.mjs --settings <path> --hooks-dir <path>
//
// A command, not a prose procedure, so it propagates identically to every
// machine that runs setup. Idempotent: re-running never duplicates an entry.
// If the shipped shim differs from what's already installed, it is updated
// in place. settings.json is backed up (timestamped sibling) before any
// write to it. Nothing is written at all if anything goes wrong — a partial
// edit to a hooks file is worse than no edit.

import {
  readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, unlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir } from '../hooks/lib/context.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const DRY_RUN = has('--dry-run');
const UNINSTALL = has('--uninstall');

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHIM_SOURCE = join(pluginRoot, 'shims', 'global-hooks', 'agent-companion-staleness.mjs');
const SHIM_FILENAME = 'agent-companion-staleness.mjs';

// --settings/--hooks-dir stay the primary override for real installer use;
// claudeDir() (AGENT_COMPANION_HOME_OVERRIDE / CLAUDE_CONFIG_DIR-aware) is
// only the fallback default, so real-world behaviour is unchanged but a test
// can redirect this without either flag.
const settingsPath = resolve(val('--settings') || join(claudeDir(), 'settings.json'));
const hooksDir = resolve(val('--hooks-dir') || join(claudeDir(), 'hooks'));
const shimDest = join(hooksDir, SHIM_FILENAME);

const EVENTS = ['SessionStart', 'UserPromptSubmit'];
// Matches hooks/hooks.json's own timeouts for this exact checker, and the
// command shape (command: "node", args: [path]) this machine's real
// ~/.claude/settings.json already uses for its other user-level hooks.
const TIMEOUTS = { SessionStart: 10, UserPromptSubmit: 5 };
const STATUS_MESSAGE = 'Checking installed-plugin staleness (agent-companion, global)';

function normPath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function hookGroupFor(event) {
  return {
    hooks: [
      {
        type: 'command',
        command: 'node',
        args: [shimDest],
        timeout: TIMEOUTS[event],
        statusMessage: STATUS_MESSAGE,
      },
    ],
  };
}

// True if some hooks[event] group already invokes our shim path (any arg
// that normalizes to it) — the idempotency check.
function eventHasShim(hooks, event) {
  const groups = hooks?.[event];
  if (!Array.isArray(groups)) return false;
  const target = normPath(shimDest);
  return groups.some((g) => Array.isArray(g?.hooks)
    && g.hooks.some((h) => Array.isArray(h?.args) && h.args.some((a) => normPath(a) === target)));
}

function loadSettings() {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

function backupFile(path) {
  if (!existsSync(path)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${path}.bak-${ts}`;
  copyFileSync(path, dest);
  return dest;
}

function shimPlan() {
  if (!existsSync(shimDest)) return 'create';
  const cur = readFileSync(shimDest, 'utf8');
  const src = readFileSync(SHIM_SOURCE, 'utf8');
  return cur === src ? 'none' : 'update';
}

function planInstall(settings) {
  const hooks = settings.hooks || {};
  const plan = { shim: shimPlan() };
  for (const event of EVENTS) plan[event] = eventHasShim(hooks, event) ? 'present' : 'add';
  return plan;
}

function applyInstall(settings, plan) {
  const next = JSON.parse(JSON.stringify(settings));
  next.hooks = next.hooks || {};
  for (const event of EVENTS) {
    if (plan[event] !== 'add') continue;
    next.hooks[event] = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    next.hooks[event].push(hookGroupFor(event));
  }
  return next;
}

function planUninstall(settings) {
  const hooks = settings.hooks || {};
  const plan = { shimExists: existsSync(shimDest) };
  for (const event of EVENTS) plan[event] = eventHasShim(hooks, event) ? 'remove' : 'absent';
  return plan;
}

function applyUninstall(settings, plan) {
  const next = JSON.parse(JSON.stringify(settings));
  next.hooks = next.hooks || {};
  const target = normPath(shimDest);
  for (const event of EVENTS) {
    if (plan[event] !== 'remove' || !Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event].filter((g) => !(Array.isArray(g?.hooks)
      && g.hooks.some((h) => Array.isArray(h?.args) && h.args.some((a) => normPath(a) === target))));
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  return next;
}

// Validate the result actually parses as the JSON we think it is before ever
// touching disk. JSON.stringify/JSON.parse round-tripping an in-memory object
// cannot itself fail, so this exists to catch a future refactor that starts
// building the settings object by string concatenation instead.
function assertValidJson(obj) {
  JSON.parse(JSON.stringify(obj));
}

function writeSettings(next) {
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
}

try {
  let settings;
  try {
    settings = loadSettings();
  } catch (e) {
    console.error(`install-global-hooks: cannot parse ${settingsPath}: ${e.message}`);
    console.error('install-global-hooks: aborted, nothing written.');
    process.exit(1);
  }

  if (UNINSTALL) {
    const plan = planUninstall(settings);
    const removing = EVENTS.filter((e) => plan[e] === 'remove');
    const anyChange = removing.length > 0 || plan.shimExists;

    console.log('install-global-hooks --uninstall: plan');
    console.log(`  shim file: ${plan.shimExists ? `remove ${shimDest}` : 'not present'}`);
    for (const event of EVENTS) {
      console.log(`  ${event} entry: ${plan[event] === 'remove' ? `remove -> ${shimDest}` : 'not present'}`);
    }

    if (!anyChange) {
      console.log('install-global-hooks: nothing to uninstall.');
      process.exit(0);
    }
    if (DRY_RUN) {
      console.log('install-global-hooks: dry run — nothing changed.');
      process.exit(0);
    }

    const next = applyUninstall(settings, plan);
    assertValidJson(next);

    let settingsBackup = null;
    if (removing.length) {
      settingsBackup = backupFile(settingsPath);
      writeSettings(next);
    }
    if (plan.shimExists) {
      const shimBackup = `${shimDest}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(shimDest, shimBackup);
      unlinkSync(shimDest);
      console.log(`install-global-hooks: shim backed up to ${shimBackup} and removed.`);
    }
    if (settingsBackup) console.log(`install-global-hooks: settings backed up to ${settingsBackup}.`);
    console.log('install-global-hooks: uninstalled.');
    process.exit(0);
  }

  // --- install ---------------------------------------------------------
  const plan = planInstall(settings);
  const adding = EVENTS.filter((e) => plan[e] === 'add');
  const anyChange = adding.length > 0 || plan.shim !== 'none';

  console.log('install-global-hooks: plan');
  console.log(`  shim file: ${plan.shim === 'none' ? `up to date at ${shimDest}` : `${plan.shim} ${shimDest}`}`);
  for (const event of EVENTS) {
    console.log(`  ${event} entry: ${plan[event] === 'add' ? `add -> ${shimDest}` : 'already present'}`);
  }

  if (!anyChange) {
    console.log('install-global-hooks: already installed and up to date.');
    process.exit(0);
  }
  if (DRY_RUN) {
    console.log('install-global-hooks: dry run — nothing changed.');
    process.exit(0);
  }

  const next = applyInstall(settings, plan);
  assertValidJson(next);

  let settingsBackup = null;
  if (adding.length) {
    settingsBackup = backupFile(settingsPath);
    writeSettings(next);
  }
  if (plan.shim !== 'none') {
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(SHIM_SOURCE, shimDest);
  }
  if (settingsBackup) console.log(`install-global-hooks: settings backed up to ${settingsBackup}.`);
  console.log('install-global-hooks: installed.');
  process.exit(0);
} catch (e) {
  console.error(`install-global-hooks: aborted, nothing written (${e.message})`);
  process.exit(1);
}
