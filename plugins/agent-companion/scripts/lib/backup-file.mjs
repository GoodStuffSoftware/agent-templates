// backup-file.mjs — shared by the opt-in installers (install-reinject-hook,
// install-compact-instructions): copy a file aside before rewriting it, and
// keep only the newest few backups of each target.
import { accessSync, constants, copyFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const KEEP_BACKUPS = 3;

// Copies `path` to `<path>.bak-<ISO timestamp>` and returns the backup path,
// or null when there is nothing to back up. Throws (and writes nothing) when
// `path` is not writable, so a doomed write leaves no stray backup. Prunes
// all but the newest `keep` backups of `path`.
export function backupFile(path, { keep = KEEP_BACKUPS } = {}) {
  if (!existsSync(path)) return null;
  accessSync(path, constants.W_OK);
  const dest = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(path, dest);
  pruneBackups(path, keep);
  return dest;
}

// Deletes all but the newest `keep` `<path>.bak-*` files (the ISO timestamp
// sorts lexically). Returns the deleted paths.
export function pruneBackups(path, keep = KEEP_BACKUPS) {
  const dir = dirname(path); const prefix = `${basename(path)}.bak-`;
  const olds = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse().slice(Math.max(0, keep));
  for (const f of olds) unlinkSync(join(dir, f));
  return olds.map((f) => join(dir, f));
}
