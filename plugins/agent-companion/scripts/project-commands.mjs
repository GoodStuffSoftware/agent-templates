#!/usr/bin/env node
// project-commands.mjs -- CLI for the per-project command lists (<configDir>/project-commands.json).
// The file format, the check against the resource gate and the spawn-hook block are in hooks/lib/project-commands.mjs.
//
// Usage:
//   node project-commands.mjs list
//   node project-commands.mjs show [path-or-name]        the list for a folder (default: here) or a key, with any problems
//   node project-commands.mjs set <name-or-path> <install|testFile|suite|lint|build|cwd> <value>
//                                                        value "-" removes it. A command that is not one plain command the gate takes is refused
//   node project-commands.mjs derive <repo path> [--save] [--key <name-or-path>]
//                                                        proposes entries from package.json, a Makefile, gradle and the project's docs; prints them,
//                                                        and writes them only with --save (keyed by the repo folder name unless --key is given)
// A key is a repo folder name or the path of its main checkout (a worktree matches its main repo); a path key wins over a name key.

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { writeTextAtomic } from '../hooks/lib/context.mjs';
import { repoOf, normalisePath, isPathKey } from '../hooks/lib/project-tier.mjs';
import { COMMAND_KINDS, checkCommand, commandsFor, commandsPath, loadCommands } from '../hooks/lib/project-commands.mjs';
import { deriveCommands } from './lib/derive-commands.mjs';

const [cmd, ...rawArgs] = process.argv.slice(2);
const save = rawArgs.includes('--save');
const args = rawArgs.filter((a) => a !== '--save');
const keyIdx = args.indexOf('--key');
const keyOpt = keyIdx >= 0 ? args.splice(keyIdx, 2)[1] : null;
const USAGE = 'Usage: project-commands.mjs list | show [path-or-name] | set <name-or-path> <kind|cwd> <value|-> | derive <repo path> [--save] [--key <k>]';

function fail(msg) { console.error(`project-commands: ${msg}`); process.exit(1); }

function readRaw() {
  const p = commandsPath();
  if (!existsSync(p)) return { projects: {} };
  let raw;
  try { raw = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (e) { fail(`${p} is not valid JSON, not changed: ${String(e.message || e).slice(0, 80)}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${p}: top level is not an object, not changed`);
  if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) raw.projects = {};
  return raw;
}
function writeRaw(raw) {
  if (!writeTextAtomic(commandsPath(), `${JSON.stringify(raw, null, 2)}\n`)) fail(`not changed: could not write ${commandsPath()}`);
}
function keyFor(text) {
  const t = String(text ?? '').trim();
  if (!t) fail(`a project name or path is needed. ${USAGE}`);
  if (isPathKey(t)) {
    const repo = repoOf(t);
    return repo ? repo.mainRoot : normalisePath(t);
  }
  return t;
}
function printEntry(key, cmds, cwd) {
  console.log(`${key}${cwd ? `  (cwd ${cwd})` : ''}`);
  for (const k of COMMAND_KINDS) if (cmds[k]) console.log(`  ${k}: ${cmds[k]}`);
}

function listCmd() {
  const c = loadCommands();
  console.log(`file: ${c.path}${c.exists ? '' : ' (not created yet)'}`);
  for (const e of c.entries) printEntry(e.key, e.cmds, e.cwd);
  for (const p of c.problems) console.log(`problem: ${p}`);
}
function showCmd() {
  const c = loadCommands();
  const target = args[0] ?? process.cwd();
  let e = isPathKey(target) || existsSync(target) ? commandsFor(target, c) : null;
  if (!e) e = c.entries.find((x) => x.key.toLowerCase() === String(target).toLowerCase()) ?? null;
  if (e) printEntry(e.project ?? e.key, e.cmds, e.cwd); else console.log(`no command list for ${target}`);
  for (const p of c.problems) console.log(`problem: ${p}`);
}
function setCmd() {
  if (args.length < 3) fail(`set needs a project, a kind and a value. ${USAGE}`);
  const [k, kind, ...rest] = args;
  const value = rest.join(' ').trim();
  if (kind !== 'cwd' && !COMMAND_KINDS.includes(kind)) fail(`unknown kind "${kind}": use ${COMMAND_KINDS.join(', ')}, cwd`);
  const key = keyFor(k);
  if (value !== '-' && kind !== 'cwd') {
    const bad = checkCommand(kind, value);
    if (bad) fail(`refused: ${kind} ${bad}. Not changed.`);
  }
  const raw = readRaw();
  const have = Object.keys(raw.projects).find((x) => x.toLowerCase() === key.toLowerCase()) ?? key;
  const entry = raw.projects[have] && typeof raw.projects[have] === 'object' ? raw.projects[have] : {};
  if (value === '-') delete entry[kind]; else entry[kind] = value;
  raw.projects[have] = entry;
  writeRaw(raw);
  console.log(`${value === '-' ? 'removed' : 'set'} ${kind} for ${have}`);
}
function deriveCmd() {
  if (!args[0]) fail(`derive needs a repo path. ${USAGE}`);
  if (!existsSync(args[0])) fail(`no such folder: ${args[0]}`);
  const repo = repoOf(args[0]);
  const dir = repo ? repo.ownRoot : normalisePath(args[0]);
  const { entries, dropped } = deriveCommands(dir);
  const key = keyOpt ? keyFor(keyOpt) : (repo?.name ?? basename(dir));
  if (!Object.keys(entries).length) console.log(`nothing found in ${dir}`);
  else {
    console.log(`proposed for ${key}:`);
    for (const k of COMMAND_KINDS) if (entries[k]) console.log(`  ${k}: ${entries[k].command}   [${entries[k].source}]`);
  }
  for (const d of dropped) console.log(`dropped: ${d}`);
  if (!save) { console.log('(not saved: add --save to write these)'); return; }
  if (!Object.keys(entries).length) return;
  const raw = readRaw();
  const have = Object.keys(raw.projects).find((x) => x.toLowerCase() === key.toLowerCase()) ?? key;
  const entry = raw.projects[have] && typeof raw.projects[have] === 'object' ? raw.projects[have] : {};
  for (const [k, v] of Object.entries(entries)) entry[k] = v.command;
  raw.projects[have] = entry;
  writeRaw(raw);
  console.log(`saved to ${commandsPath()}`);
}

try {
  switch (cmd) {
    case undefined:
    case 'list': listCmd(); break;
    case 'show': showCmd(); break;
    case 'set': setCmd(); break;
    case 'derive': deriveCmd(); break;
    default: fail(`unknown command "${cmd}". ${USAGE}`);
  }
} catch (e) {
  fail(String(e?.message || e));
}
