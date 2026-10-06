// The fs tripwire shared by the two halves of the real-home guard:
//   - tests/isolate.mjs arms it in every test process (records into memory);
//   - tests/child-guard.mjs arms it in every node child a test spawns, through
//     NODE_OPTIONS --import (records into a log file the parent checks).
// Test-only support file; nothing in the plugin imports it.
//
// armTripwire() wraps the node:fs / node:fs/promises entry points so that any
// call whose resolved absolute path lands under one of `roots` THROWS (the
// offending test fails at the call) and is reported through `onViolation`
// (plugin code mostly fails open and would swallow the throw, so the report is
// what fails the file).

import fs from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports as syncEsm } from 'node:module';

const win = process.platform === 'win32';
export const canon = (s) => {
  const n = String(s).replace(/\\/g, '/').replace(/\/+$/, '');
  return win ? n.toLowerCase() : n;
};

const toPath = (a) => {
  try {
    if (typeof a === 'string') return a;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(a)) return a.toString('utf8');
    if (a instanceof URL) return fileURLToPath(a);
  } catch { /* not path-like */ }
  return null;
};

// Path arguments by function: most take the path first; these take two paths.
const TWO_PATH = new Set(['renameSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync', 'rename', 'copyFile', 'cp', 'link', 'symlink']);
const FNS = [
  // reads
  'existsSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'openSync', 'accessSync',
  'realpathSync', 'readlinkSync', 'opendirSync', 'createReadStream', 'readFile', 'readdir', 'stat',
  'lstat', 'open', 'access', 'realpath', 'readlink', 'opendir', 'exists', 'watch', 'watchFile', 'globSync', 'glob',
  'statfs', 'statfsSync', 'openAsBlob',
  // writes
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync',
  'copyFileSync', 'cpSync', 'truncateSync', 'utimesSync', 'chmodSync', 'symlinkSync', 'linkSync',
  'mkdtempSync', 'createWriteStream', 'writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink',
  'rename', 'copyFile', 'cp', 'truncate', 'utimes', 'chmod', 'symlink', 'link', 'mkdtemp',
  'chownSync', 'lchownSync', 'lutimesSync', 'lchmodSync', 'chown', 'lchown', 'lutimes', 'lchmod',
];

// roots: absolute paths (any slash style). token: names this arming, so that
// arming twice with the same token is a no-op while two different armings
// (the in-process one and the child preload, in a nested run) both apply.
// onViolation(record: string): called before the throw.
export function armTripwire({ roots, token, onViolation }) {
  const watched = roots.map(canon);

  function underWatched(arg) {
    const p = toPath(arg);
    if (p === null || p === '') return null;
    let abs;
    try { abs = canon(resolve(p)); } catch { return null; }
    for (const c of watched) {
      if (abs === c || abs.startsWith(`${c}/`)) return abs;
    }
    return null;
  }

  function patch(mod, name, label) {
    const orig = mod?.[name];
    if (typeof orig !== 'function' || orig.__acGuards?.has(token)) return;
    const wrapper = function (...args) {
      const hit = underWatched(args[0]) || (TWO_PATH.has(name) ? underWatched(args[1]) : null);
      if (hit) {
        const who = process.argv[1] ? `${basename(process.argv[1])}: ` : '';
        onViolation(`${who}${label}${name} ${hit}`);
        throw new Error(`test touched the REAL Claude home: ${who}${label}${name}(${hit}) — tests must stay inside their sandbox (see tests/isolate.mjs)`);
      }
      return orig.apply(this, args);
    };
    // Carry own properties across (exists.__promisify__ and the like); the
    // .native variants of realpath are functions of their own, so they are
    // wrapped, not copied.
    for (const k of Object.keys(orig)) {
      try { wrapper[k] = orig[k]; } catch { /* non-writable: skip */ }
    }
    wrapper.__acGuards = new Set([...(orig.__acGuards || []), token]);
    if (typeof orig.native === 'function') patch(wrapper, 'native', `${label}${name}.`);
    try { mod[name] = wrapper; } catch { /* frozen: skip */ }
  }

  for (const name of FNS) patch(fs, name, 'fs.');
  try { for (const name of FNS) patch(fs.promises, name, 'fs.promises.'); } catch { /* no promises API */ }
  // Named imports of 'node:fs' in modules loaded from here on read the patched
  // functions; sync the facade for any that were materialised before this ran.
  try { syncEsm(); } catch { /* best effort */ }
}
