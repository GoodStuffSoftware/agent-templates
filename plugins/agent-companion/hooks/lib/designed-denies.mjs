// Deny texts of agent-companion guards that are working as designed. A worker transcript shows a guard deny as
// "PreToolUse:<Tool> hook error: <text>", the same shape as a crash, so release-watch recognises a designed deny by its wording:
// a prefix of the text (after "hook error: ") listed here. A deny listed here is never a hook error and never a new signature.
// Each prefix is taken from the guard's own text or constant, so the list cannot drift from the guard. A new guard deny that tells
// the worker what to do instead: export its text or constant and add it below (tests/release-watch.test.mjs fails on an exported *_MSG constant that is missing).
import { HEAVY_DENY_PREFIX } from './resource-gate.mjs';
import { WORKTREE_DENY_PREFIX } from './worktree-remove.mjs';
import { WRITER_DENY_REASON } from './scope-tripwire.mjs';
import { ENV_MSG } from './env-dump-guard.mjs';
import { KILL_MSG, UNINSTALL_MSG } from './process-kill-guard.mjs';
import { PUSH_DELETE_MSG } from './push-delete-guard.mjs';
import { PY_MSG } from './python-stdin.mjs';
import { denyText } from './handoff-limit.mjs';
import { workerWaitDenyText } from './poll-guard.mjs';

const HEAD = 40; // long enough that a crash message cannot share it, short enough to survive a wording change later in the text
const head = (s) => String(s).slice(0, HEAD);
const upToDigit = (s) => String(s).replace(/\d[\s\S]*$/, ''); // the part before the first variable number

// Strings are prefixes; a RegExp is anchored by its author. Built on first use: some guards import release-watch-state, which imports this file.
let cached = null;
export const designedDenyPrefixes = () => cached || (cached = [
  HEAVY_DENY_PREFIX,                                  // hooks/lib/resource-gate.mjs: the command must go through the resource queue
  WORKTREE_DENY_PREFIX,                               // hooks/lib/worktree-remove.mjs: use the safe removal script
  head(WRITER_DENY_REASON),                           // hooks/lib/scope-tripwire.mjs: new files beyond the brief
  head(ENV_MSG),                                      // hooks/lib/env-dump-guard.mjs: would print variable values
  head(KILL_MSG),                                     // hooks/lib/process-kill-guard.mjs: kill by image name
  head(UNINSTALL_MSG),                                // hooks/lib/process-kill-guard.mjs: plugin uninstall through the CLI
  head(PUSH_DELETE_MSG),                              // hooks/lib/push-delete-guard.mjs: remote delete
  head(PY_MSG),                                       // hooks/lib/python-stdin.mjs: python reading stdin
  upToDigit(denyText(1, 2)),                          // hooks/lib/handoff-limit.mjs: context past the hard limit ("[agent-companion] Context at ")
  head(workerWaitDenyText('')),                       // hooks/lib/poll-guard.mjs: a second sleep, poll or watch loop
  /^\d+ calls refused: write the handoff now/,        // hooks/lib/handoff-limit.mjs streakPrefix
  // Guards that run outside this plugin (the operator's own PreToolUse hooks) have no constant here to import; their wording is listed literally.
  'DESTRUCTIVE GIT (backup rule',
  'Git Bash `rm -rf` follows an NTFS junction',
  'Not shown: you are a subagent',
]);

export const isDesignedDeny = (text) => {
  const t = String(text || '').trimStart();
  return designedDenyPrefixes().some((p) => (p instanceof RegExp ? p.test(t) : p.length > 0 && t.startsWith(p)));
};

// The variable parts of a signature (paths, box and other numbers) collapse, so one kind of error is one signature.
export const normalizeSignature = (text) => String(text || '')
  .replace(/[A-Za-z]:[\\/][^\s)'"]*|(?:\/[\w.@~-]+){2,}/g, '<path>')
  .replace(/\d+/g, 'N');
