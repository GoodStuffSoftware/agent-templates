// Deny texts of agent-companion guards that are working as designed. A worker transcript shows a guard deny as
// "PreToolUse:<Tool> hook error: <text>", the same shape as a crash, so release-watch recognises a designed deny by its wording:
// a prefix of the text (after "hook error: ") listed here, next to the guards that write it. A deny listed here is never a hook
// error and never a new signature. Add a guard's prefix when it gets a deny that tells the worker what to do instead.
export const DESIGNED_DENY_PREFIXES = [
  'Heavy command (',                      // hooks/lib/resource-gate.mjs: the command must go through the resource queue
  'git worktree remove not run',          // hooks/lib/worktree-remove.mjs: use the safe removal script
  'Check in with the lead before',        // hooks/lib/scope-tripwire.mjs WRITER_DENY_REASON: new files beyond the brief
];

export const isDesignedDeny = (text) => { const t = String(text || '').trimStart(); return DESIGNED_DENY_PREFIXES.some((p) => t.startsWith(p)); };

// The variable parts of a signature (paths, box and other numbers) collapse, so one kind of error is one signature.
export const normalizeSignature = (text) => String(text || '')
  .replace(/[A-Za-z]:[\\/][^\s)'"]*|(?:\/[\w.@~-]+){2,}/g, '<path>')
  .replace(/\d+/g, 'N');
