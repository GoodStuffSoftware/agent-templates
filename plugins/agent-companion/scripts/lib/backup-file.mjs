// backup-file.mjs — shared by the opt-in installers (install-reinject-hook,
// install-compact-instructions): copy a file aside before rewriting it.
import { copyFileSync, existsSync } from 'node:fs';

// Copies `path` to `<path>.bak-<ISO timestamp>` and returns the backup path,
// or null when there is nothing to back up.
export function backupFile(path) {
  if (!existsSync(path)) return null;
  const dest = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(path, dest);
  return dest;
}
