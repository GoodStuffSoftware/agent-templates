// backup-file.mjs — shared by the opt-in installers (install-reinject-hook,
// install-compact-instructions): copy a file aside before rewriting it, and
// keep only the newest few of OUR backups of each target.
//
// Our backups are named `<file>.bak-agent-companion-<ISO timestamp>` and
// pruning matches only that exact pattern, so an operator's own `<file>.bak-*`
// files (hand-made, or plain `<file>.bak-<ISO>` ones written by 0.29.8's
// re-inject installer, indistinguishable from hand-made) are never touched.
import { accessSync, constants, copyFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const KEEP_BACKUPS = 3;
export const BACKUP_TAG = '.bak-agent-companion-';
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

// Copies `path` to `<path>.bak-agent-companion-<timestamp>` and returns the
// backup path, or null when there is nothing to back up. Throws (and writes
// nothing) when `path` is not writable, so a doomed write leaves no stray
// backup. Prunes all but the newest `keep` of our backups of `path`.
export function backupFile(path, { keep = KEEP_BACKUPS } = {}) {
  if (!existsSync(path)) return null;
  accessSync(path, constants.W_OK);
  const dest = `${path}${BACKUP_TAG}${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(path, dest);
  pruneBackups(path, keep);
  return dest;
}

// Deletes all but the newest `keep` of OUR backups of `path` (exact name
// pattern with a valid timestamp; it sorts lexically). Returns deleted paths.
export function pruneBackups(path, keep = KEEP_BACKUPS) {
  const dir = dirname(path); const prefix = `${basename(path)}${BACKUP_TAG}`;
  const ours = readdirSync(dir).filter((f) => f.startsWith(prefix) && STAMP.test(f.slice(prefix.length)));
  const olds = ours.sort().reverse().slice(Math.max(0, keep));
  for (const f of olds) unlinkSync(join(dir, f));
  return olds.map((f) => join(dir, f));
}
