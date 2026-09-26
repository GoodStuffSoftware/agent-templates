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
// Detect-existing: a "Compact instructions" heading outside our markers means
// the operator already steers compaction; install refuses (exit 0, nothing
// written) unless --force. Unbalanced/duplicated markers: refuses (exit 1).
// Idempotent; the file is backed up before any write.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { claudeDir } from '../hooks/lib/context.mjs';
import { backupFile } from './lib/backup-file.mjs';
import { BLOCK_LINES, inspect, withBlock, withoutBlock } from './lib/compact-instructions.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const NAME = 'install-compact-instructions';
const DRY_RUN = has('--dry-run');
const target = resolve(val('--target') || join(claudeDir(), 'CLAUDE.md'));

try {
  if (has('--print')) { console.log(BLOCK_LINES.join('\n')); process.exit(0); }
  const text = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const { state, foreign, problem } = inspect(text);
  if (problem) {
    console.error(`${NAME}: ${target}: ${problem}; refusing to edit it, nothing written.`);
    process.exit(1);
  }
  const foreignNote = foreign ? '; another "Compact instructions" section is present' : '';

  if (has('--status')) {
    const s = state === 'ours' ? 'installed' : state === 'ours-stale' ? 'installed (older text; re-run to refresh)' : 'not installed';
    console.log(`${NAME}: ${s} in ${target}${foreignNote}`);
    process.exit(0);
  }

  const apply = (next, verb) => {
    if (DRY_RUN) { console.log(`${NAME}: dry run — would ${verb} ${target}; nothing changed.`); process.exit(0); }
    const b = backupFile(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, next);
    if (b) console.log(`${NAME}: backed up to ${b}.`);
    console.log(`${NAME}: ${verb === 'remove the block from' ? 'uninstalled' : 'installed'} (${target}).`);
    process.exit(0);
  };

  if (has('--uninstall')) {
    if (state === 'absent') { console.log(`${NAME}: nothing to uninstall.`); process.exit(0); }
    apply(withoutBlock(text), 'remove the block from');
  }

  if (state === 'ours') { console.log(`${NAME}: already installed and up to date (${target}).`); process.exit(0); }
  if (state === 'absent' && foreign && !has('--force')) {
    console.log(`${NAME}: ${target} already has a "Compact instructions" section; not adding a second one. Use --force to add it anyway.`);
    process.exit(0);
  }
  apply(withBlock(text), state === 'ours-stale' ? 'refresh the block in' : 'append the block to');
} catch (e) {
  console.error(`${NAME}: aborted (${e.message})`);
  process.exit(1);
}
