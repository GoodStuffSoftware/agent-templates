#!/usr/bin/env node
// install-compact-instructions.mjs — adds the OPTIONAL "Compact instructions"
// block (scripts/lib/compact-instructions.mjs) to a CLAUDE.md so automatic
// compaction keeps the current task, open decisions, paths and the handoff
// location. The companion to install-reinject-hook.mjs (which restores saved
// state AFTER compaction). Never run automatically: `/ac setup` shows the
// block and runs this only after the operator says yes.
//
// Usage:
//   node install-compact-instructions.mjs [--dry-run] [--force] [--target <CLAUDE.md>]
//   node install-compact-instructions.mjs --uninstall [--dry-run] [--target <CLAUDE.md>]
//   node install-compact-instructions.mjs --status [--target <CLAUDE.md>]
//   node install-compact-instructions.mjs --print      (prints the block, changes nothing)
// --target defaults to the user-level ~/.claude/CLAUDE.md.
//
// Default target: the docs describe Compact instructions in the PROJECT-ROOT
// CLAUDE.md (code.claude.com/docs/en/costs — "customize compaction behavior in
// your CLAUDE.md file at the root of your project"; docs/en/context-window,
// "What survives compaction", lists only the project-root CLAUDE.md as
// re-injected). The user-level file is in context at compaction but is not
// documented to steer it. We still default to user-level because writing a
// project's CLAUDE.md dirties a repo (possibly a public one); --print,
// --status and the setup skill say so and name --target for the documented path.
//
// Detect-existing: a "Compact instructions" heading outside our markers means
// the operator already steers compaction; install refuses (exit 0, nothing
// written) unless --force. Unbalanced/duplicated markers: refuses (exit 1).
// Idempotent; the file is backed up before any write (newest 3 kept);
// install then uninstall restores the file byte for byte, and removes it
// when install created it.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { claudeDir } from '../hooks/lib/context.mjs';
import { backupFile } from './lib/backup-file.mjs';
import { isMain } from './lib/is-main.mjs';
import { BLOCK_LINES, inspect, withBlock, withoutBlock } from './lib/compact-instructions.mjs';

export const DOC_PATH_NOTE = 'The docs describe Compact instructions in the project-root CLAUDE.md; '
  + 'the user-level file is in context at compaction but not documented to steer it. '
  + 'For the documented path use `--target <repo>/CLAUDE.md` (it then shows up in git).';

const NAME = 'install-compact-instructions';

function main(argv) {
  const has = (n) => argv.includes(n);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const DRY_RUN = has('--dry-run');
  const userLevel = resolve(join(claudeDir(), 'CLAUDE.md'));
  const target = resolve(val('--target') || userLevel);
  const note = () => { if (target === userLevel) console.log(`${NAME}: note: ${DOC_PATH_NOTE}`); };

  if (has('--print')) { console.log(BLOCK_LINES.join('\n')); console.log(`\n${DOC_PATH_NOTE}`); return 0; }
  const existed = existsSync(target);
  const text = existed ? readFileSync(target, 'utf8') : '';
  const { state, foreign, created, problem } = inspect(text);
  if (problem) {
    console.error(`${NAME}: ${target}: ${problem}; refusing to edit it, nothing written.`);
    return 1;
  }
  const foreignNote = foreign ? '; another "Compact instructions" section is present' : '';

  if (has('--status')) {
    const s = state === 'ours' ? 'installed' : state === 'ours-stale' ? 'installed (older text; re-run to refresh)' : 'not installed';
    console.log(`${NAME}: ${s} in ${target}${foreignNote}`);
    note();
    return 0;
  }

  const apply = (next, verb, done) => {
    const remove = done === 'uninstalled' && created && next === '';
    if (DRY_RUN) { console.log(`${NAME}: dry run — would ${remove ? 'delete' : verb} ${target}; nothing changed.`); return 0; }
    const b = backupFile(target);
    if (remove) unlinkSync(target);
    else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, next); }
    if (b) console.log(`${NAME}: backed up to ${b}.`);
    console.log(`${NAME}: ${done} (${target}${remove ? ', removed: install had created it' : ''}).`);
    if (done !== 'uninstalled') note();
    return 0;
  };

  if (has('--uninstall')) {
    if (state === 'absent') { console.log(`${NAME}: nothing to uninstall.`); return 0; }
    return apply(withoutBlock(text), 'remove the block from', 'uninstalled');
  }

  if (state === 'ours') { console.log(`${NAME}: already installed and up to date (${target}).`); return 0; }
  if (state === 'absent' && foreign && !has('--force')) {
    console.log(`${NAME}: ${target} already has a "Compact instructions" section; not adding a second one. Use --force to add it anyway.`);
    return 0;
  }
  return apply(withBlock(text, { created: !existed }),state === 'ours-stale' ? 'refresh the block in' : 'append the block to', 'installed');
}

if (isMain(import.meta.url)) {
  let code;
  try { code = main(process.argv.slice(2)); } catch (e) {
    console.error(`${NAME}: aborted (${e.message})`);
    code = 1;
  }
  process.exit(code);
}
