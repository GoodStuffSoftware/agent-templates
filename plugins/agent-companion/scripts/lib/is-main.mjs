// is-main.mjs — true when the module at `metaUrl` is the script node was
// started with (process.argv[1]), so a CLI's top-level code does not run
// when the file is imported.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const norm = (p) => {
  let s = resolve(p);
  try { s = realpathSync(s); } catch { /* keep the resolved path */ }
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  return norm(process.argv[1]) === norm(fileURLToPath(metaUrl));
}
