// The child-process half of the real-home tripwire. Test-only support file;
// nothing in the plugin imports it.
//
// tests/isolate.mjs adds `--import <this file>` to NODE_OPTIONS, so every node
// process a test spawns (and every node process THAT spawns, down the tree)
// arms the same fs tripwire the test process has: a call under the operator's
// real Claude home throws in the child, and is appended to a log the parent
// reads when its file ends (isolate.mjs fails the file on a non-empty log).
//
// WHY A LOG AND NOT JUST THE THROW. Plugin code fails open by design, so a
// child that catches the throw still exits 0 and the parent sees nothing. The
// log is the record that survives.
//
// Env contract (set by isolate.mjs; absent = inert, so a stray import is safe):
//   AC_TEST_GUARD_ROOTS  JSON array of absolute roots to watch
//   AC_TEST_GUARD_LOG    absolute path of the log (inside the sandbox, which is
//                        not a watched root)

import fs from 'node:fs';
import { armTripwire } from './tripwire.mjs';

const rootsJson = process.env.AC_TEST_GUARD_ROOTS;
const log = process.env.AC_TEST_GUARD_LOG;
// The original function object, held before arming replaces fs.appendFileSync.
const append = fs.appendFileSync;

if (rootsJson && log) {
  let roots = [];
  try { roots = JSON.parse(rootsJson); } catch { roots = []; }
  if (Array.isArray(roots) && roots.length) {
    // `append` is the unwrapped original and the log is outside every watched
    // root, so recording can never recurse into the wrappers.
    armTripwire({
      roots,
      token: 'child',
      onViolation: (record) => {
        try { append(log, `pid ${process.pid}\t${record}\n`); } catch { /* best effort: the throw still fires */ }
      },
    });
  }
}
