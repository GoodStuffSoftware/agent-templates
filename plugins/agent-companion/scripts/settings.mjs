#!/usr/bin/env node
// settings.mjs -- CLI for the settings home (`/ac settings`). The home is one plain JSON file,
// <state root>/config/settings.json (usually ~/.claude/agent-companion/config/settings.json), keyed by the option
// names plugin.json `userConfig` declares. opt() reads it FIRST (hooks/lib/context.mjs, "The settings home"); this
// script lists, reads, writes and migrates it. It never reads or edits the sensitive store, and it never edits
// Claude Code's own settings files.
//
// Usage:
//   node settings.mjs list [--all]    options in the home file or differing from their default (--all: every option), the config files, problems
//   node settings.mjs get <key>       effective value, where it comes from, the declared default, the other sources that set it
//   node settings.mjs set <key> <value>   write the home file (refuses unknown keys, wrong types, sensitive options)
//   node settings.mjs unset <key>     remove the entry from the home file
//   node settings.mjs where           the home folder, the home file, where Claude Code keeps plugin options
//   node settings.mjs migrate [--dry-run]   copy plugin options into the home file; move old top-level config files into config/
//
// Zero dependencies. Exit 0 unless something really failed (a refusal, an unreadable or invalid file); bad arguments
// print one usage line and exit 2.

import { existsSync, readFileSync, mkdirSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  explainOption, declaredOptions, settingsHomePath, settingsHomeValue, settingsHomeProblems,
  resetSettingsHomeCache, configFileStatus, stateRootPath, claudeDir, pluginName, pluginOptionEntries,
  optionValueFits, writeTextAtomic, LEGACY_TOPLEVEL_CONFIG_FILES,
} from '../hooks/lib/context.mjs';

const USAGE = 'Usage: settings.mjs list [--all] | get <key> | set <key> <value> | unset <key> | where | migrate [--dry-run]';

function usage() {
  console.error(USAGE);
  process.exit(2);
}

function fail(msg) {
  console.error(`settings: ${msg}`);
  process.exit(1);
}

// ---- display helpers --------------------------------------------------------------------------------------------
function show(v) {
  if (v === undefined) return '(none)';
  if (typeof v === 'string') {
    const j = JSON.stringify(v);
    return j.length > 90 ? `${j.slice(0, 87)}..."` : j;
  }
  return String(v);
}

const SOURCE_LABEL = {
  home: 'the home file',
  env: 'the environment',
  'settings.local.json': 'Claude Code plugin options (settings.local.json)',
  'settings.json': 'Claude Code plugin options (settings.json)',
  default: 'the declared default',
};
function sourceText(e) {
  const label = SOURCE_LABEL[e.source] || e.source;
  return e.detail ? `${label}: ${e.detail}` : label;
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---- nearest names ----------------------------------------------------------------------------------------------
function lev(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const t = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return row[b.length];
}

function nearest(key, names) {
  const k = key.toLowerCase();
  const kt = new Set(k.split('_').filter((t) => t.length > 2));
  const thr = Math.max(3, Math.ceil(k.length / 3));
  return names
    .map((n) => {
      const nl = n.toLowerCase();
      const shared = nl.split('_').filter((t) => kt.has(t)).length;
      return { n, d: lev(k, nl), sub: nl.includes(k) || (nl.length > 3 && k.includes(nl)), shared };
    })
    .filter((s) => s.sub || s.shared > 0 || s.d <= thr)
    .sort((a, b) => (b.sub - a.sub) || (b.shared - a.shared) || (a.d - b.d))
    .slice(0, 3)
    .map((s) => s.n);
}

function unknownKey(key) {
  const near = nearest(key, declaredOptions().map((o) => o.key));
  const hint = near.length ? ` Nearest names: ${near.join(', ')}.` : ' Run `settings.mjs list --all` for every option.';
  fail(`"${key}" is not an option this plugin declares.${hint}`);
}

// ---- the home file ----------------------------------------------------------------------------------------------
// Read for writing: { exists, obj, style } or { error }. A file that is not a JSON object is never written over.
function readHomeForWrite() {
  const path = settingsHomePath();
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { path, exists: false, obj: {}, style: { eol: '\n', indent: '  ', bom: false } };
    return { path, error: `cannot read ${path} (${e && e.code ? e.code : 'error'}); nothing was written` };
  }
  const bom = text.charCodeAt(0) === 0xFEFF;
  const body = bom ? text.slice(1) : text;
  const style = { eol: body.includes('\r\n') ? '\r\n' : '\n', indent: '  ', bom };
  const trimmed = body.trim();
  if (trimmed === '') return { path, exists: true, obj: {}, style };
  if (!trimmed.includes('\n')) style.indent = 0; // a one-line file stays one line
  else { const m = /^([ \t]+)"/m.exec(body); if (m) style.indent = m[1]; }
  let obj;
  try { obj = JSON.parse(body); } catch {
    return { path, error: `${path} is not valid JSON; fix or move it first. Nothing was written.` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { path, error: `${path} does not hold one JSON object; fix or move it first. Nothing was written.` };
  }
  return { path, exists: true, obj, style };
}

function writeHome(path, obj, style) {
  const folder = join(stateRootPath(), 'config');
  try { mkdirSync(folder, { recursive: true }); } catch (e) {
    fail(`could not create the folder ${folder} (${e && e.code ? e.code : 'error'}); nothing was written`);
  }
  let text = JSON.stringify(obj, null, style.indent);
  if (style.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  text = `${style.bom ? '﻿' : ''}${text}${style.eol}`;
  if (!writeTextAtomic(path, text)) fail(`could not write ${path}`);
  resetSettingsHomeCache();
}

// ---- commands ---------------------------------------------------------------------------------------------------
function cmdList(args) {
  let all = false;
  for (const a of args) { if (a === '--all') all = true; else usage(); }
  const specs = declaredOptions();
  const rows = specs.map((s) => explainOption(s.key));
  // A key present in the home file is always shown (even at the default: it pins the value against the other
  // sources); so is every option whose effective value differs from the default.
  const shown = all ? rows : rows.filter((e) => settingsHomeValue(e.key) !== undefined || (e.source !== 'default' && !same(e.value, e.default)));
  console.log(all
    ? `All ${rows.length} options:`
    : `Options in the home file or differing from their default (${shown.length} of ${rows.length}; --all lists every option):`);
  if (!shown.length) console.log('  none: the home file sets nothing and every option is at its declared default');
  for (const e of shown) {
    const val = e.sensitive ? e.value : show(e.value);
    console.log(`  ${e.key} = ${val}`);
    console.log(`      from ${sourceText(e)}; default ${show(e.default)}${e.empty ? '; an empty value reads as unset' : ''}`);
    const lower = overridden(e);
    if (lower.length) console.log(`      shadows: ${lower.map((h) => `${SOURCE_LABEL[h.source] || h.source} (${h.detail})`).join('; ')}`);
  }
  const root = stateRootPath();
  console.log('');
  console.log(`Config files (folder ${join(root, 'config')}):`);
  for (const f of configFileStatus(root)) {
    const flags = [];
    if (f.oldLocation) flags.push('OLD PLACE: read from the state root top level; `settings.mjs migrate` moves it into config/');
    if (f.shadowedOld) flags.push(`an old copy at ${join(root, f.name)} is shadowed by this one and unused`);
    console.log(`  ${f.name}: ${f.path} (${f.exists ? 'present' : 'not present'})${flags.length ? `  [${flags.join('; ')}]` : ''}`);
  }
  const problems = settingsHomeProblems();
  console.log('');
  console.log(`Problems in the home file (${settingsHomePath()}):`);
  if (!problems.length) console.log('  none');
  for (const p of problems) console.log(`  ${p.message}`);
}

// Every source that holds a value for this key, in the order opt() reads them: { source, detail, value }.
function holders(key, sensitive) {
  const out = [];
  const home = settingsHomeValue(key);
  if (home !== undefined) out.push({ source: 'home', detail: settingsHomePath(), value: home });
  const seen = new Set();
  for (const name of [`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`, `CLAUDE_PLUGIN_OPTION_${key}`]) {
    const id = process.platform === 'win32' ? name.toUpperCase() : name; // Windows names are case-insensitive: one variable, one row
    if (seen.has(id)) continue;
    seen.add(id);
    if (process.env[name] !== undefined) out.push({ source: 'env', detail: name, value: sensitive ? '(set, hidden)' : process.env[name] });
  }
  for (const e of pluginOptionEntries()) {
    if (Object.prototype.hasOwnProperty.call(e.options, key)) {
      out.push({ source: basename(e.file) === 'settings.local.json' ? 'settings.local.json' : 'settings.json', detail: e.file, value: sensitive ? '(set, hidden)' : e.options[key] });
    }
  }
  return out;
}

// The other sources that set this option while the one in `e` wins (shared by `list` and `get`).
function overridden(e) {
  return holders(e.key, e.sensitive).filter((h) => !(h.source === e.source && h.detail === e.detail));
}

function cmdGet(args) {
  if (args.length !== 1) usage();
  const key = args[0];
  const e = explainOption(key);
  if (!e.declared) unknownKey(key);
  console.log(`${e.key} = ${e.sensitive ? e.value : show(e.value)}`);
  console.log(`  from:    ${sourceText(e)}${e.empty ? ' (empty, read as unset)' : ''}`);
  console.log(`  default: ${show(e.default)}`);
  console.log(`  type:    ${e.type}${e.sensitive ? ' (sensitive: never stored in the home file)' : ''}`);
  const others = overridden(e);
  if (others.length) {
    console.log(`  also set (not used; ${SOURCE_LABEL[e.source] || e.source} shadows them):`);
    for (const h of others) console.log(`    ${SOURCE_LABEL[h.source] || h.source}: ${h.detail} = ${typeof h.value === 'string' && h.value === '(set, hidden)' ? h.value : show(h.value)}`);
  } else {
    console.log('  no other source sets it');
  }
  for (const p of settingsHomeProblems()) {
    if (p.key === key) console.log(`  home file entry ignored: ${p.message}`);
    else if (p.key === null) console.log(`  home file problem: ${p.message}`);
  }
}

function parseValue(spec, raw) {
  if (spec.type === 'boolean') {
    const t = raw.trim().toLowerCase();
    if (t === 'true') return { ok: true, value: true };
    if (t === 'false') return { ok: true, value: false };
    return { ok: false, why: `"${spec.key}" is a boolean: use true or false` };
  }
  if (spec.type === 'number') {
    const n = raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, why: `"${spec.key}" is a number: "${raw}" is not one` };
  }
  return { ok: true, value: raw };
}

function cmdSet(args) {
  if (args.length !== 2) usage();
  const [key, raw] = args;
  const spec = declaredOptions().find((o) => o.key === key);
  if (!spec) unknownKey(key);
  if (spec.sensitive) fail(`"${key}" is a sensitive option. It is never written to the home file (a plain text file); set it in Claude Code's plugin settings, which keep it in the system credential store.`);
  const parsed = parseValue(spec, raw);
  if (!parsed.ok) fail(`${parsed.why}. Nothing was written.`);
  if (!optionValueFits(spec.type, parsed.value)) fail(`"${key}" must be a ${spec.type}. Nothing was written.`);
  const h = readHomeForWrite();
  if (h.error) fail(h.error);
  const before = explainOption(key);
  h.obj[key] = parsed.value;
  writeHome(h.path, h.obj, h.style);
  const after = explainOption(key);
  console.log(`Set ${key} = ${show(parsed.value)} in ${h.path}`);
  console.log(`  was ${show(before.value)} (from ${SOURCE_LABEL[before.source] || before.source}); now ${show(after.value)} (from ${SOURCE_LABEL[after.source] || after.source})`);
  if (after.empty) console.log('  an empty string reads as unset: the declared default applies');
}

function cmdUnset(args) {
  if (args.length !== 1) usage();
  const key = args[0];
  const h = readHomeForWrite();
  if (h.error) fail(h.error);
  if (!Object.prototype.hasOwnProperty.call(h.obj, key)) {
    const e = explainOption(key);
    if (!e.declared) unknownKey(key);
    console.log(`${key} is not set in the home file (${h.path}); nothing changed.`);
    console.log(`  it is ${e.sensitive ? e.value : show(e.value)} (from ${sourceText(e)})`);
    return;
  }
  delete h.obj[key];
  writeHome(h.path, h.obj, h.style);
  const e = explainOption(key);
  console.log(`Removed ${key} from ${h.path}`);
  console.log(`  it now falls back to ${e.sensitive ? e.value : show(e.value)} (from ${sourceText(e)})`);
}

function cmdWhere(args) {
  if (args.length) usage();
  const root = stateRootPath();
  console.log(`home folder: ${join(root, 'config')}`);
  console.log(`home file:   ${settingsHomePath()}`);
  console.log(`Claude Code plugin options: ${join(claudeDir(), 'settings.json')} and ${join(claudeDir(), 'settings.local.json')} (under pluginConfigs, key "${pluginName()}@<marketplace>", then options)`);
  console.log('sensitive plugin options: the system credential store (not a file)');
}

function cmdMigrate(args) {
  let dry = false;
  for (const a of args) { if (a === '--dry-run') dry = true; else usage(); }
  const root = stateRootPath();
  const confDir = join(root, 'config');
  const specs = new Map(declaredOptions().map((o) => [o.key, o]));
  let failed = false;
  console.log(dry ? 'settings migrate (dry run: nothing is written or moved)' : 'settings migrate');

  // 1. plugin options -> the home file
  const h = readHomeForWrite();
  const copied = []; const kept = []; const sensitive = []; const undeclared = []; const badType = [];
  const winner = new Map(); // key -> value of the entry opt() would use (the first one)
  const holdersOf = []; // { file, configKey, key }
  for (const e of pluginOptionEntries()) {
    for (const key of Object.keys(e.options)) {
      holdersOf.push({ file: e.file, configKey: e.configKey, key });
      if (!winner.has(key)) winner.set(key, e.options[key]);
    }
  }
  console.log('');
  console.log(`Plugin options -> home file ${h.path}`);
  const newHome = h.error ? null : { ...h.obj };
  if (h.error) {
    console.log(`  skipped: ${h.error}`);
    failed = true;
  } else {
    for (const [key, value] of winner) {
      const spec = specs.get(key);
      if (!spec) { undeclared.push(key); continue; }
      if (spec.sensitive) { sensitive.push(key); continue; }
      if (Object.prototype.hasOwnProperty.call(h.obj, key)) { kept.push(key); continue; }
      if (!optionValueFits(spec.type, value)) { badType.push(key); continue; }
      newHome[key] = value;
      copied.push(key);
    }
    if (copied.length && !dry) writeHome(h.path, newHome, h.style); // before the "copied" line: a failed write reports nothing as copied
    const line = (label, list) => { if (list.length) console.log(`  ${label} (${list.length}): ${list.join(', ')}`); };
    line(dry ? 'would copy' : 'copied', copied);
    line('already in the home file, kept as they are', kept);
    line('skipped, sensitive', sensitive);
    line('skipped, not an option this plugin declares', undeclared);
    line('skipped, value does not match the declared type', badType);
    if (!winner.size) console.log('  no plugin options are set in Claude Code settings; nothing to copy');
  }

  // 2. old top-level config files -> config/
  console.log('');
  console.log(`Config files -> ${confDir}`);
  const moved = []; const both = [];
  for (const name of LEGACY_TOPLEVEL_CONFIG_FILES) {
    const oldPath = join(root, name);
    const newPath = join(confDir, name);
    if (!existsSync(oldPath)) continue;
    if (existsSync(newPath)) { both.push(name); continue; }
    if (!dry) {
      try {
        mkdirSync(confDir, { recursive: true });
        try { renameSync(oldPath, newPath); } catch {
          // No rename (another drive, or the file is open elsewhere): copy, then remove the old file. If the old file
          // cannot be removed, undo the copy: there is never a second copy of a config file.
          copyFileSync(oldPath, newPath);
          try { unlinkSync(oldPath); } catch (ue) {
            let undone = true;
            try { unlinkSync(newPath); } catch { undone = false; }
            const code = ue && ue.code ? ue.code : 'error';
            console.log(undone
              ? `  ${name} left where it is: it is in use (${code}), so it was not moved; close whatever has it open and run migrate again`
              : `  ${name} could not be moved (${code}) and the copy made in config/ could not be undone: remove ${newPath} by hand`);
            failed = true;
            continue;
          }
        }
      } catch (e) {
        try { if (existsSync(newPath) && existsSync(oldPath)) unlinkSync(newPath); } catch { /* best effort */ }
        console.log(`  could not move ${name} (${e && e.code ? e.code : 'error'}); left where it is`);
        failed = true;
        continue;
      }
    }
    moved.push(name);
  }
  if (moved.length) console.log(`  ${dry ? 'would move' : 'moved'} (${moved.length}): ${moved.join(', ')}`);
  if (both.length) console.log(`  not moved, a copy already exists in config/ (it wins; the old top-level copy is unused and left for you to remove) (${both.length}): ${both.join(', ')}`);
  if (!moved.length && !both.length) console.log('  no config files at the old top-level place');

  // 3. what the user may now remove from Claude Code's own settings (never edited here)
  const inHome = new Set([...kept, ...copied]);
  const byFile = new Map();
  for (const x of holdersOf) {
    const spec = specs.get(x.key);
    if (!spec || spec.sensitive || !inHome.has(x.key)) continue;
    const id = `${x.file} (pluginConfigs "${x.configKey}", options)`;
    if (!byFile.has(id)) byFile.set(id, []);
    byFile.get(id).push(x.key);
  }
  console.log('');
  if (byFile.size) {
    console.log(`Claude Code's own settings were not touched. ${dry ? 'After a real migrate you' : 'You'} may now remove these option keys there; the home file holds them:`);
    for (const [id, keys] of byFile) console.log(`  in ${id}: ${keys.join(', ')}`);
  } else {
    console.log("Claude Code's own settings were not touched. No option keys there are covered by the home file.");
  }
  resetSettingsHomeCache();
  if (failed) process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  console.log(USAGE);
  process.exit(0);
}
switch (cmd) {
  case 'list': cmdList(args); break;
  case 'get': cmdGet(args); break;
  case 'set': cmdSet(args); break;
  case 'unset': cmdUnset(args); break;
  case 'where': cmdWhere(args); break;
  case 'migrate': cmdMigrate(args); break;
  default: usage();
}
