// Push-delete guard: a `git push` that deletes refs on the remote is denied unless the
// command carries the destructive-git ack (`# guard-ack: destructive-git`), the marker
// the operator's command guard uses for the same class of command.
//
// Deleting forms: a refspec with an empty source (`:ref`, `+:ref`, quoted or not),
// --delete, a short option cluster holding d (`-d`, `-fd`), --prune and --mirror.
// Defence in depth for the 2026-10-18 incident, where a wrapped `git push origin
// $M:refs/heads/b` ran with M empty and deleted the branch: the hook cannot see a
// shell variable's value, so `$M:ref` is allowed (the queue wrap now keeps M set);
// a literal empty source is not.
//
// One exception: the merged-branch clean-up grammar the operator's command guard
// (hooks/command-guard.mjs under the Claude home) proves merged before it allows,
// `git -C <X:/abs/path> push <remote> --delete <name>...` or `... push <remote> :<name>...`
// as the whole command, is left to that guard when it is installed.
// Pure logic; poll-guard.mjs wires it. Fails open.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { scanCommand, wordsOf } from './resource-gate.mjs';

export const PUSH_DELETE_ACK = /guard-ack:\s*destructive-git\b/;
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path']);
const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const CLEANUP_GRAMMAR = /^git +-C +[A-Za-z]:\/[A-Za-z0-9._/-]* +push +[A-Za-z0-9._-]+(?: +--delete(?: +[A-Za-z0-9._/-]+)+|(?: +:[A-Za-z0-9._/-]+)+)$/;
const PREFIX_CMDS = new Set(['env', 'command', 'time', 'nohup', 'nice', 'sudo', 'exec']);
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);

export const PUSH_DELETE_MSG = 'Remote delete refused: this `git push` deletes refs on the remote (an empty-source refspec `:<ref>` or `+:<ref>`, --delete, -d, --prune or --mirror). '
  + 'If a source was meant to be there, a shell variable was empty: check it before pushing. '
  + 'If the delete is intended: first push a backup ref of what it deletes (`git push <remote> <sha>:refs/heads/backup/<branch>-pre-<reason>-YYYY-MM-DD`) and verify it, '
  + 'then re-run the command with `# guard-ack: destructive-git` appended.';

const base = (w) => String(w).replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();

/** The deleting form in one segment's words ('empty-source :x' | '--delete' | ...), or null. */
export function pushDeleteInWords(rawWords, depth = 0) {
  let w = rawWords.slice();
  for (;;) {
    while (w.length && (SHELL_KEYWORDS.has(w[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w = w.slice(1);
    if (w.length && PREFIX_CMDS.has(base(w[0]))) { w = w.slice(1); while (w.length && w[0].startsWith('-')) w = w.slice(1); continue; }
    break;
  }
  if (!w.length) return null;
  const cmd = base(w[0]);
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(cmd) && depth < 2) {
    const i = w.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    return i >= 0 && w[i + 1] !== undefined ? pushDeleteHits(w[i + 1], depth + 1) : null;
  }
  if (cmd !== 'git') return null;
  let i = 1;
  while (i < w.length && w[i].startsWith('-')) i += GIT_VALUE_OPTS.has(w[i]) ? 2 : 1;
  if (w[i] !== 'push') return null;
  const args = w.slice(i + 1);
  const end = args.indexOf('--');
  const optArgs = end < 0 ? args : args.slice(0, end);
  if (optArgs.includes('--dry-run') || optArgs.some((a) => /^-[A-Za-z0-9]*n/.test(a) && !a.startsWith('--'))) return null; // changes nothing
  const positional = [];
  let opts = true;
  for (let j = 0; j < args.length; j += 1) {
    const a = args[j];
    if (opts && a === '--') { opts = false; continue; }
    if (opts && a.startsWith('--')) {
      if (a === '--delete') return '--delete';
      if (a === '--prune') return '--prune';
      if (a === '--mirror') return '--mirror';
      if (PUSH_VALUE_OPTS.has(a)) j += 1;
      continue;
    }
    if (opts && /^-[A-Za-z0-9]/.test(a)) {
      const letters = a.slice(1);
      for (let k = 0; k < letters.length; k += 1) {
        if (letters[k] === 'd') return '-d';
        if (letters[k] === 'o') { if (k === letters.length - 1) j += 1; break; } // -o takes a value
      }
      continue;
    }
    positional.push(a);
  }
  // positional[0] is the remote; the rest are refspecs.
  const empty = positional.slice(1).find((r) => /^\+?:./.test(r));
  return empty ? `empty-source ${empty}` : null;
}

/** The first deleting push in a command line, or null. Never throws. */
export function pushDeleteHits(command, depth = 0) {
  try {
    const s = String(command ?? '');
    if (!/push/.test(s)) return null;
    for (const seg of scanCommand(s).segments) {
      const hit = pushDeleteInWords(wordsOf(seg.text), depth);
      if (hit) return hit;
    }
    return null;
  } catch { return null; }
}

function commandGuardInstalled(env = process.env) {
  const home = env.CLAUDE_CONFIG_DIR || join(env.AGENT_COMPANION_HOME_OVERRIDE || homedir(), '.claude');
  return existsSync(join(home, 'hooks', 'command-guard.mjs'));
}

/** Hook entry: { kind: 'push-delete', message, mode: 'deny', detail } or null. */
export function pushDeleteGuard(payload, { env = process.env, guardInstalled = commandGuardInstalled } = {}) {
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || PUSH_DELETE_ACK.test(command)) return null;
  const hit = pushDeleteHits(command);
  if (!hit) return null;
  if (CLEANUP_GRAMMAR.test(command.trim()) && guardInstalled(env)) return null;
  return { kind: 'push-delete', message: PUSH_DELETE_MSG, mode: 'deny', detail: `${hit}: ${command}` };
}
