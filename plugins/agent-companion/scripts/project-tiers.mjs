#!/usr/bin/env node
// project-tiers.mjs -- CLI for project tiers (`/ac tier`). Reads and writes the user's
// <configDir>/project-tiers.json through hooks/lib/project-tier.mjs, which owns the file
// format and the tolerant loader; the wording is in hooks/lib/tier-text.mjs.
//
// Usage:
//   node project-tiers.mjs list
//   node project-tiers.mjs show [path]              the project, project_tier and source for a folder (default: here)
//   node project-tiers.mjs set <name-or-path> <push|risk|gates>
//   node project-tiers.mjs unset <name-or-path>
//   node project-tiers.mjs landing <name-or-path|--default> <pr|direct|clear>
//                                                   how work lands (optional): pr = through a pull request, direct = commit and push to
//                                                   the branch the brief names; clear removes it. --default sets the top-level mode
//   node project-tiers.mjs floor <base>..<head>     the least risk a diff allows, and why. Two dots: a plain diff of the two refs;
//                                                   three dots (<base>...<head>): the diff from their merge base, as a branch review reads it
//
// A project key is a repo folder name ("acme-app") or a full path. Given an existing path, `set` stores the
// normalised path of that repo's MAIN checkout (so every worktree of it matches); given a bare name it stores the name.
// A path key wins over a name key. Zero dependencies; hand-rolled argv like scripts/rules.mjs.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { writeTextAtomic } from '../hooks/lib/context.mjs';
import {
  TIER_IDS, DEFAULT_TIER, LANDING_MODES, loadTiers, tiersPath, tierDetail, repoOf, normalisePath, isPathKey,
} from '../hooks/lib/project-tier.mjs';
import { TIERS, riskFloor } from '../hooks/lib/tier-text.mjs';
import { cleanGitEnv } from './lib/git-env.mjs';

const [cmd, ...args] = process.argv.slice(2);
const USAGE = 'Usage: project-tiers.mjs list | show [path] | set <name-or-path> <push|risk|gates> | unset <name-or-path> | landing <name-or-path|--default> <pr|direct|clear> | floor <base>..<head> | floor <base>...<head>';

function fail(msg, code = 1) {
  console.error(`project-tiers: ${msg}`);
  process.exit(code);
}

const tierName = (id) => `${id} (${TIERS[id].label})`;

function listCmd() {
  const c = loadTiers();
  console.log(`Project tiers (${c.path})${c.exists ? '' : ' -- no file yet: every project is tier ' + DEFAULT_TIER}`);
  console.log(`  default: ${tierName(c.default)}`);
  console.log(`  landing: ${c.landing || 'not set (the plugin says nothing about how work lands)'}`);
  console.log(`  sessionLine: ${c.sessionLine}`);
  console.log(`  reviewEveryChange: ${c.reviewEveryChange}`);
  if (c.entries.length) {
    console.log('  projects:');
    for (const e of c.entries) console.log(`    ${e.key} -> ${e.tier ? tierName(e.tier) : 'default tier'}${e.landing ? `, landing ${e.landing}` : ''}${e.isPath ? '  (path)' : ''}`);
  } else {
    console.log('  projects: none assigned');
  }
  for (const p of c.problems) console.log(`  problem: ${p}`);
  console.log(`Tiers: ${TIER_IDS.map((id) => `${id} = ${TIERS[id].label}`).join('; ')}`);
}

function showCmd() {
  const target = args[0] || process.cwd();
  const d = tierDetail(target);
  console.log(`path: ${normalisePath(target)}`);
  console.log(`project: ${d.project || '(none: not inside a repo)'}`);
  if (d.mainRoot) console.log(`repo: ${d.mainRoot}`);
  if (d.ownRoot && d.mainRoot && d.ownRoot.toLowerCase() !== d.mainRoot.toLowerCase()) console.log(`worktree: ${d.ownRoot}`);
  console.log(`project_tier: ${tierName(d.tier)}`);
  const why = d.source === 'assigned' ? `assigned by ${d.by} "${d.key}"`
    : d.source === 'default' ? `default (no entry sets a tier for this project; default is ${d.config.default})`
      : 'none (not inside a repo; the default applies)';
  console.log(`source: ${why}`);
  console.log(`meaning: ${TIERS[d.tier].meaning}`);
  console.log(`landing: ${d.landing ? `${d.landing} (${d.landing === 'direct' ? 'no pull requests; commit and push to the branch the brief names' : 'through a pull request'})` : 'not set (the plugin says nothing about how work lands)'}`);
  const landWhy = d.landingSource === 'assigned' ? `assigned by ${d.landingBy} "${d.landingKey}"`
    : d.landingSource === 'default' ? 'the top-level default landing mode'
      : 'none (no project entry or default sets one)';
  console.log(`landing_source: ${landWhy}`);
  console.log(`file: ${tiersPath()}${d.config.exists ? '' : ' (absent)'}`);
  for (const p of d.config.problems) console.log(`problem: ${p}`);
}

// What the user typed -> the key to store or remove. A path (separator, drive letter, "." or "..") that exists
// resolves to its repo's main checkout; a bare name stays a name.
function keyFor(arg, { forSet }) {
  const raw = String(arg ?? '').trim();
  if (!raw) fail(`name a project (a repo folder name or a path). ${USAGE}`);
  if (!isPathKey(raw)) return { key: raw, isPath: false };
  const abs = normalisePath(raw);
  if (existsSync(abs)) {
    const repo = repoOf(abs);
    if (repo) return { key: repo.mainRoot, isPath: true };
    if (forSet) fail(`${abs} is not inside a git repository; give the repo folder name or a path inside a repo.`);
    return { key: abs, isPath: true };
  }
  if (/^[\\/]|^[a-zA-Z]:/.test(raw)) return { key: abs, isPath: true }; // an absolute path that does not exist (yet)
  fail(`${abs} does not exist. Give an absolute path, or the repo folder name.`);
}

const sameKey = (a, b) => (isPathKey(a) && isPathKey(b)
  ? normalisePath(a).toLowerCase() === normalisePath(b).toLowerCase()
  : !isPathKey(a) && !isPathKey(b) && a.trim().toLowerCase() === b.trim().toLowerCase());

// Read the file as authored for an edit. A missing file starts from the documented shape; one that
// is not a JSON object (or whose "projects" is not one) is left alone and the edit refused.
function readRawForEdit() {
  const file = tiersPath();
  if (!existsSync(file)) return { default: DEFAULT_TIER, sessionLine: true, reviewEveryChange: false, projects: {} };
  if (!statSync(file).isFile()) fail(`not changed: ${file} is not a file (a folder is there instead). It was left untouched; remove it, then retry.`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
    fail(`not changed: ${file} is not valid JSON (${String(e.message || e).slice(0, 80)}). It was left untouched; fix or remove it, then retry.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`not changed: ${file} must hold a JSON object. It was left untouched.`);
  if ('projects' in raw && (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects))) {
    fail(`not changed: "projects" in ${file} must be an object. It was left untouched.`);
  }
  if (!('projects' in raw)) raw.projects = {};
  return raw;
}

function writeRaw(raw) {
  if (!writeTextAtomic(tiersPath(), `${JSON.stringify(raw, null, 2)}\n`)) fail(`not changed: could not write ${tiersPath()}. Check that the folder is writable.`);
}

function setCmd() {
  if (args.length < 2 || !String(args[0] ?? '').trim()) fail(`set needs a project and a tier. ${USAGE}`);
  const tier = String(args[1] ?? '').trim().toLowerCase();
  if (!TIER_IDS.includes(tier)) fail(`unknown tier "${args[1] ?? ''}": use ${TIER_IDS.join(', ')}. ${USAGE}`);
  const { key } = keyFor(args[0], { forSet: true });
  const raw = readRawForEdit();
  let landing = null;
  for (const k of Object.keys(raw.projects)) {
    if (!sameKey(k, key)) continue;
    const old = raw.projects[k];
    if (old && typeof old === 'object' && !Array.isArray(old) && old.landing !== undefined) landing = old.landing; // keep the landing mode as written
    delete raw.projects[k];
  }
  raw.projects[key] = landing === null ? tier : { tier, landing };
  writeRaw(raw);
  console.log(`${key} -> ${tierName(tier)}`);
}

// landing <name-or-path|--default> <pr|direct|clear>: set or clear the landing mode for one project or the top-level default.
// A project entry that is a tier string becomes {tier, landing}; clearing turns it back into the string. An entry with a
// landing but no tier (as `landing` writes for a path whose repo is assigned by name) leaves the tier to the other entries
// (name entry, then the default): tier and landing resolve on their own. Entries that are not touched are not rewritten.
function landingCmd() {
  const mode = String(args[1] ?? '').trim().toLowerCase();
  if (args.length < 2 || !String(args[0] ?? '').trim()) fail(`landing needs a project (or --default) and a mode. ${USAGE}`);
  const clear = ['clear', 'none', 'unset'].includes(mode);
  if (!clear && !LANDING_MODES.includes(mode)) fail(`unknown landing mode "${args[1] ?? ''}": use ${LANDING_MODES.join(', ')} or clear. ${USAGE}`);
  const raw = readRawForEdit();
  if (args[0] === '--default') {
    if (clear) delete raw.landing; else raw.landing = mode;
    writeRaw(raw);
    console.log(clear ? 'default landing cleared: the plugin says nothing about landing unless a project sets it.' : `default landing -> ${mode}`);
    return;
  }
  const { key } = keyFor(args[0], { forSet: true });
  const hits = Object.keys(raw.projects).filter((k) => sameKey(k, key));
  const old = hits.length ? raw.projects[hits[hits.length - 1]] : undefined;
  const isObj = !!old && typeof old === 'object' && !Array.isArray(old);
  const tier = isObj ? old.tier : old; // a tier string, or undefined for no entry or a tier-less object
  if (clear && !hits.length) fail(`no entry for ${key} in ${tiersPath()}; nothing to clear. Run \`list\` to see the keys.`);
  for (const k of hits) delete raw.projects[k];
  const entry = {};
  if (tier !== undefined) entry.tier = tier;
  if (!clear) entry.landing = mode;
  if (isObj) for (const [f, v] of Object.entries(old)) if (f !== 'tier' && f !== 'landing') entry[f] = v;
  const fields = Object.keys(entry);
  if (fields.length === 1 && fields[0] === 'tier') raw.projects[key] = entry.tier;
  else if (fields.length) raw.projects[key] = entry; // else nothing is left: the entry is gone
  writeRaw(raw);
  console.log(clear ? `${key}: landing cleared` : `${key}: landing -> ${mode}`);
}

function unsetCmd() {
  const { key } = keyFor(args[0], { forSet: false });
  const raw = readRawForEdit();
  const hit = Object.keys(raw.projects).filter((k) => sameKey(k, key));
  if (!hit.length) fail(`no entry for ${key} in ${tiersPath()}. Run \`list\` to see the keys.`);
  for (const k of hit) delete raw.projects[k];
  writeRaw(raw);
  console.log(`removed ${hit.join(', ')}; that project now follows the default (${raw.default || DEFAULT_TIER}).`);
}

function git(argv) {
  const r = spawnSync('git', argv, { encoding: 'utf8', windowsHide: true, env: cleanGitEnv(), maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? 'git is not on PATH' : String(r.error.message));
  if (r.status !== 0) throw new Error(String(r.stderr || `git ${argv[0]} failed`).trim().split('\n')[0]);
  return r.stdout;
}

// package.json counts as a build change only when its "scripts" changed.
function scriptsChanged(base, head, path) {
  try {
    const a = JSON.parse(git(['show', `${base}:${path}`])).scripts || {};
    const b = JSON.parse(git(['show', `${head}:${path}`])).scripts || {};
    return JSON.stringify(a) !== JSON.stringify(b);
  } catch { return false; }
}

function floorCmd() {
  const range = String(args[0] ?? '');
  try {
    const m = /^([^.\s][^\s]*?)(\.{2,3})([^\s]+)$/.exec(range);
    if (!m || range.startsWith('-')) throw new Error('give a range as <base>..<head> (or <base>...<head> for the diff from their merge base)');
    const [, a, dots, head] = m;
    // Three dots: the diff from the merge base of the two to the head, as `git diff a...b` reads it. Two dots: a plain diff of the two.
    const base = dots === '...' ? git(['merge-base', a, head]).trim() : a;
    const numstat = git(['diff', '--numstat', '--no-renames', '-z', `${base}..${head}`, '--']).split('\0').filter(Boolean);
    const status = git(['diff', '--name-status', '--no-renames', '-z', `${base}..${head}`, '--']).split('\0').filter(Boolean);
    const isNew = new Set();
    for (let i = 0; i + 1 < status.length; i += 2) if (status[i] === 'A') isNew.add(status[i + 1]);
    const files = numstat.map((rec) => {
      const [a, d, ...p] = rec.split('\t');
      const path = p.join('\t');
      const f = { path, added: Number(a) || 0, deleted: Number(d) || 0, isNew: isNew.has(path) };
      if (basename(path) === 'package.json' && !isNew.has(path) && scriptsChanged(base, head, path)) f.forceKind = 'CI/build/deploy/hook';
      return f;
    });
    const r = riskFloor(files);
    console.log(`floor: ${r.floor}`);
    console.log(`reason: ${r.reasons.join('; ')}`);
    console.log('A writer may state a higher risk, never a lower one; a reviewer may raise it, never lower it.');
  } catch (e) {
    console.log(`floor unknown: ${String(e?.message || e).slice(0, 200)}`);
  }
}

try {
  switch (cmd) {
    case undefined:
    case 'list': listCmd(); break;
    case 'show': showCmd(); break;
    case 'set': setCmd(); break;
    case 'unset': unsetCmd(); break;
    case 'landing': landingCmd(); break;
    case 'floor': floorCmd(); break;
    default: fail(`unknown command "${cmd}". ${USAGE}`);
  }
} catch (e) {
  fail(String(e?.message || e));
}
