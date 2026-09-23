// Thin wrappers around node:child_process's sync exec/spawn family that
// force windowsHide: true on every call.
//
// WHY THIS EXISTS — the hidden-window rule (see hooks/hooks.json's
// command+args convention and hooks/lib/memory-index.mjs's runGit(), which
// established this first for the hook path). On Windows, whichever process
// actually ALLOCATES a console -- git.exe, node.exe, a shell resolving a
// .cmd/.bat shim -- pops a real, focus-stealing window unless windowsHide
// rides the SAME spawn that creates it. A flag set on an outer/ancestor
// process does not propagate through a shell hop or an unflagged child.
// Measured on this machine ({{PROJECT}}, 2026-09-20) and documented in
// ~/.claude/skills/team-orchestration/SKILL.md under "A dev server must
// open NO window".
//
// Several call sites here (`claude --version`, `claude plugin validate`) are
// STUCK with a shell on Windows regardless, because `claude` is a .cmd shim
// that only resolves through one -- see the comments at each call site. That
// does not make windowsHide pointless there: it is the shell's own console
// that gets hidden, exactly the case this module exists to cover.
//
// Never call the raw node:child_process functions directly from a script in
// this directory -- route through here. hooks/lib/memory-index.mjs's own
// runGit() sets the same flag inline instead of importing this module, so
// hooks/ never depends on scripts/ (scripts/ already depends on hooks/lib,
// and the reverse would be a layering cycle). A static test
// (tests/no-visible-windows.test.mjs) asserts every child_process call in
// hooks/ and scripts/ carries windowsHide, specifically so a new call site
// added later cannot silently reopen this.

import {
  execSync as _execSync,
  execFileSync as _execFileSync,
  spawnSync as _spawnSync,
} from 'node:child_process';

export function execSyncHidden(command, options = {}) {
  return _execSync(command, { windowsHide: true, ...options });
}

export function execFileSyncHidden(file, args = [], options = {}) {
  return _execFileSync(file, args, { windowsHide: true, ...options });
}

export function spawnSyncHidden(command, args = [], options = {}) {
  return _spawnSync(command, args, { windowsHide: true, ...options });
}
