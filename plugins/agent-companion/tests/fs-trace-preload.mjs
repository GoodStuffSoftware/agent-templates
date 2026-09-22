// FS-access tripwire, loaded into an audited child via
// NODE_OPTIONS=--import. Test-only support file; nothing in the plugin imports
// it.
//
// WHY THIS EXISTS. The first version of audit-no-real-home.test.mjs detected a
// leak only when a forbidden path appeared VERBATIM as a string in the JSON
// report. That signal is absent for the two sites the original bug actually
// lived in: memory-index-ceiling reports `f.project`, which is the ENCODED
// directory name (every : \ / already replaced by -, so it contains no
// `.claude` substring), and instruction-budget reports only a label ("global
// CLAUDE.md: ~N tok / M lines"). Both read the operator's real tree and emit
// nothing a scanner can see, and neither writes, so the write-side inventory
// misses them too. An output scan cannot guard this boundary. Watching the
// filesystem calls themselves can.
//
// It wraps the read entry points of node:fs / node:fs/promises and records any
// call whose RESOLVED absolute path falls under a watched root. Patching the
// builtin's exports before the ESM facade is materialised is what makes this
// reach `import { existsSync } from 'node:fs'` in audit.mjs and checks.mjs —
// verified, not assumed.
//
// Two properties this relies on:
//   * existsSync counts. A probe of a path that does not exist still proves the
//     resolver AIMED at the forbidden tree, so this catches a bad resolver on a
//     machine where the operator has no such file at all — including CI.
//   * The log goes to a file OUTSIDE the sentinel and nothing is ever written
//     to stdout, so the trace cannot disturb the report the caller parses, the
//     sentinel inventory, or a check that compares a child's stdout.
//
// Env contract (all set by the test):
//   AC_FS_TRACE_LOG    absolute path of the log file; absent = tracer inert
//   AC_FS_TRACE_ROOTS  JSON array of absolute roots to watch
//
// Log lines are tab-separated: `ARMED <pid> <argv>` once per process, and
// `HIT <pid> <fn> <path>` per access. The caller asserts ARMED is present, so
// a tracer that silently failed to load can never be mistaken for a clean run.

import { createRequire } from 'node:module';

const LOG = process.env.AC_FS_TRACE_LOG;

if (LOG) {
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const path = require('node:path');
  const { fileURLToPath } = require('node:url');

  // Captured BEFORE patching, and a write path anyway, so recording can never
  // recurse into the wrappers.
  const append = fs.appendFileSync;

  const win = process.platform === 'win32';
  const canon = (s) => {
    const n = String(s).replace(/\\/g, '/');
    return win ? n.toLowerCase() : n;
  };

  let roots = [];
  try { roots = JSON.parse(process.env.AC_FS_TRACE_ROOTS || '[]').map(canon); } catch { roots = []; }

  const toPath = (a) => {
    try {
      if (typeof a === 'string') return a;
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(a)) return a.toString('utf8');
      if (a instanceof URL) return fileURLToPath(a);
    } catch { /* not a path-like argument */ }
    return null;
  };

  const record = (fn, arg) => {
    const p = toPath(arg);
    if (p === null) return;
    let abs;
    try { abs = canon(path.resolve(p)); } catch { return; }
    for (const r of roots) {
      if (abs === r || abs.startsWith(`${r}/`)) {
        try { append(LOG, `HIT\t${process.pid}\t${fn}\t${abs}\n`); } catch { /* best effort */ }
        return;
      }
    }
  };

  const patch = (mod, name) => {
    const orig = mod?.[name];
    if (typeof orig !== 'function') return;
    const wrapper = function (...args) {
      record(name, args[0]);
      return orig.apply(this, args);
    };
    // Carry own properties across (e.g. realpathSync.native), so wrapping does
    // not quietly remove an API the plugin might use.
    for (const k of Object.keys(orig)) {
      try { wrapper[k] = orig[k]; } catch { /* non-writable: skip */ }
    }
    try { mod[name] = wrapper; } catch { /* frozen: skip */ }
  };

  const READ_FNS = [
    'existsSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'openSync',
    'accessSync', 'realpathSync', 'readlinkSync', 'opendirSync', 'globSync',
    'createReadStream', 'readFile', 'readdir', 'stat', 'lstat', 'open', 'access',
    'realpath', 'readlink', 'opendir', 'exists', 'watch', 'watchFile',
  ];
  for (const name of READ_FNS) patch(fs, name);

  // node:fs/promises is a distinct module object with its own bindings.
  try {
    const fsp = require('node:fs/promises');
    for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'open', 'access', 'realpath', 'readlink', 'opendir', 'glob']) {
      patch(fsp, name);
    }
  } catch { /* older runtime without fs/promises: the sync surface still covers us */ }

  try { append(LOG, `ARMED\t${process.pid}\t${process.argv.slice(1).join(' ')}\n`); } catch { /* best effort */ }
}
