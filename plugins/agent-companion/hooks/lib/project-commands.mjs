// Per-project command lists: the install, test, lint and build commands a writer should run, so it
// does not invent its own (and get denied by the resource gate).
//
// The user's file is <configDir>/project-commands.json:
//   { "projects": { "<repo folder name or full path>": { "install": "...", "testFile": "... {file}",
//                   "suite": "...", "lint": "...", "build": "...", "cwd": "<optional folder>" } } }
// A project key is the same as in project-tiers.json (a repo folder name, or the path of its main
// checkout, which every worktree of it matches; a path key wins over a name key).
//
// Every command must be ONE plain command the resource gate accepts as is: no leading cd, no && / ; / | / &
// chains, no heredocs or substitutions. checkCommand() tests that with the gate's own functions; the loader
// drops (and reports) any command that fails, so a bad entry never reaches a brief or a deny message.
// Three uses: the CLI (scripts/project-commands.mjs), the spawn hook (buildCommandsBlock) and the gate's deny
// text (listedCommandFor, called from gateDecision).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './context.mjs';
import { repoOf, normalisePath, isPathKey } from './project-tier.mjs';
import { bannedCommand, scanCommand, wrapLosesCwd, classifyCommand } from './resource-gate.mjs';

export const COMMAND_KINDS = ['install', 'testFile', 'suite', 'lint', 'build'];
export const COMMANDS_MARKER = '[agent-companion: commands]';
export const COMMANDS_MAX_CHARS = 400;
const FILE_SLOT = '{file}';
const CHAIN_RE = /[&|;`<>\n\r]|\$\(|\$\{/;

export function commandsPath() {
  return join(configDir(), 'project-commands.json');
}

// null when the command is one plain command the gate takes as is, else the reason it is not.
export function checkCommand(kind, command) {
  try {
    if (!COMMAND_KINDS.includes(kind)) return `unknown kind "${kind}" (use ${COMMAND_KINDS.join(', ')})`;
    if (typeof command !== 'string' || !command.trim()) return 'is empty';
    const c = command.trim();
    if (kind === 'testFile' && !c.includes(FILE_SLOT)) return `needs the ${FILE_SLOT} placeholder`;
    if (kind !== 'testFile' && c.includes(FILE_SLOT)) return `${FILE_SLOT} belongs only in testFile`;
    const text = c.split(FILE_SLOT).join('some.test.mjs');
    if (/^(?:cd|pushd|popd)\b/.test(text)) return 'starts with cd: set "cwd" for the project instead';
    if (CHAIN_RE.test(text)) return 'is not one plain command (no &&, ||, ;, |, &, heredoc or substitution)';
    if (/\bRESOURCE_QUEUE=/.test(text)) return 'must not set RESOURCE_QUEUE (the queue wraps it)';
    if (scanCommand(text).segments.length !== 1) return 'is more than one command';
    if (wrapLosesCwd(text)) return 'changes directory';
    const banned = bannedCommand(text, {});
    if (banned) return `the gate bans it (${banned.rule})`;
    classifyCommand(text, { cwd: process.cwd() }); // must not throw; heavy is fine: the queue wraps a plain heavy command
    return null;
  } catch (e) {
    return `could not be checked (${String(e?.message || e).slice(0, 60)})`;
  }
}

function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }

// { path, exists, entries: [{ key, isPath, cmds: {kind: command}, cwd }], problems: [string] }. Never throws.
// A command that fails checkCommand is dropped and listed in problems; an entry left with no command is dropped.
export function loadCommands() {
  const out = { path: null, exists: false, entries: [], problems: [] };
  try {
    out.path = commandsPath();
    if (!existsSync(out.path)) return out;
    out.exists = true;
    if (!isFile(out.path)) { out.problems.push('is not a file'); return out; }
    let raw;
    try { raw = JSON.parse(readFileSync(out.path, 'utf8').replace(/^﻿/, '')); } catch (e) {
      out.problems.push(`not valid JSON (${String(e.message || e).slice(0, 80)})`);
      return out;
    }
    const projects = raw && typeof raw === 'object' ? raw.projects : null;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) { out.problems.push('"projects" must be an object'); return out; }
    for (const [k, v] of Object.entries(projects)) {
      const key = k.trim();
      if (!key || !v || typeof v !== 'object' || Array.isArray(v)) { out.problems.push(`project "${key}": not an object, ignored`); continue; }
      const cmds = {};
      for (const kind of COMMAND_KINDS) {
        if (!(kind in v)) continue;
        const bad = checkCommand(kind, v[kind]);
        if (bad) out.problems.push(`project "${key}": ${kind} ${bad}: ignored`);
        else cmds[kind] = v[kind].trim();
      }
      const cwd = typeof v.cwd === 'string' && v.cwd.trim() ? v.cwd.trim() : null;
      if (Object.keys(cmds).length) out.entries.push({ key, isPath: isPathKey(key), cmds, cwd });
    }
  } catch (e) {
    out.problems.push(`could not be read (${String(e?.message || e).slice(0, 80)})`);
  }
  return out;
}

// The entry for a folder (a worktree matches its main repo): path key first, then folder name. null: no list.
export function commandsFor(cwd, cfg = null) {
  try {
    const repo = repoOf(cwd);
    if (!repo) return null;
    const c = cfg || loadCommands();
    const roots = new Set([repo.mainRoot.toLowerCase(), repo.ownRoot.toLowerCase()]);
    const byPath = c.entries.filter((e) => e.isPath && roots.has(normalisePath(e.key).toLowerCase()));
    const byName = c.entries.filter((e) => !e.isPath && e.key.toLowerCase() === String(repo.name).toLowerCase());
    const hit = byPath.length ? byPath[byPath.length - 1] : byName[byName.length - 1];
    return hit ? { project: repo.name, ...hit } : null;
  } catch { return null; }
}

const LABELS = { install: 'install', testFile: 'test a file', suite: 'suite', lint: 'lint', build: 'build' };
const ROLES = new Set(['writer', 'fixer', 'lander']);
const TYPES = new Set(['e2e', 'verify']);

// Whether a spawn of this TYPE / ROLE gets the list.
export function wantsCommands(type, role) {
  return ROLES.has(String(role || '').toLowerCase()) || TYPES.has(String(type || '').toLowerCase());
}

// The block appended to a brief, or '' (wrong role, no list, already there). At most COMMANDS_MAX_CHARS.
export function buildCommandsBlock(type, role, brief, cwd, cfg = null) {
  try {
    if (!wantsCommands(type, role)) return '';
    if (String(brief ?? '').includes(COMMANDS_MARKER)) return '';
    const e = commandsFor(cwd, cfg);
    if (!e) return '';
    const head = `\n\n${COMMANDS_MARKER} Run these as one plain command each (the queue wraps them; no cd, no &&)${e.cwd ? `; from ${e.cwd}` : ''}:`;
    let text = head;
    for (const kind of COMMAND_KINDS) {
      if (!e.cmds[kind]) continue;
      const line = `\n${LABELS[kind]}: ${e.cmds[kind]}`;
      if (text.length + line.length > COMMANDS_MAX_CHARS) break;
      text += line;
    }
    return text === head ? '' : text;
  } catch { return ''; }
}

// Which listed kind a gate class is.
const CLASS_KIND = {
  install: 'install', lint: 'lint', build: 'build', gradle: 'build',
  'vitest-dir': 'testFile', 'e2e-spec': 'testFile',
  'node-test-full': 'suite', 'vitest-full': 'suite', 'test-suite': 'suite', e2e: 'suite',
};

// A sentence naming the project's listed command for the denied classes, or ''. Never throws.
export function listedCommandFor(classes, cwd, cfg = null) {
  try {
    const e = commandsFor(cwd, cfg);
    if (!e) return '';
    for (const cls of classes || []) {
      const kind = CLASS_KIND[cls];
      if (kind && e.cmds[kind]) {
        return ` This project lists its ${LABELS[kind]} command as: ${e.cmds[kind]} (as one plain command${kind === 'testFile' ? ', with the file in place of {file}' : ''}).`;
      }
    }
  } catch { /* fail open */ }
  return '';
}
