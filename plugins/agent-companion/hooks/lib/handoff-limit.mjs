// Worker handoff limits (0.31.60): the enforcement half of the subagent context notice.
//
// What was missing. The size notice (lib/subagent-context.mjs) is advice, once, and a worker can ignore it; the optional
// ceiling (lib/context-ceiling.mjs) is advice too and is off. Nothing kept a worker from running to the ~217K
// auto-compaction. This adds, on the SAME hook and the SAME transcript reading (hooks/subagent-context.mjs, PreToolUse,
// subagents only; the lead is never touched):
//   warn        (option subagent_context_warn_tokens, default 110000, 0 = off)  once: keep the handoff file current
//   soft limit  (option subagent_context_notice_tokens, default 110000; subagent_context_notice_high_tokens, default 130000, for
//               ac-sonnet-high, ac-sonnet-xhigh and the ac-opus-* rungs)  the handoff notice, then again every
//               subagent_context_notice_repeat_tokens (default 15000) while the context keeps growing
//   hard limit  (option subagent_context_hard_tokens, default 150000)    a PreToolUse deny of everything except what a handoff
//               needs: Write/Edit/Read of a .md file whose name contains "handoff", and Bash/PowerShell that is only git add,
//               commit, push, status, diff or log with the options listed per verb below (cd to a path is allowed in front of them)
//   switch      subagent_handoff_limits (default on); exemptions subagent_handoff_exempt_types (comma list, default empty)
// Switch off, or an exempt agent type: the whole handoff mechanism (notice, repeats, deny) does nothing for that worker;
// the compaction note is separate and unchanged. Any error: do nothing (the hook fails open).
//
// Defaults and why (operator decision 2026-11; usage review: calls over 150K were about 40% of subagent cost, and the
// longest workers ran 135-206 calls up to 209-217K context before the auto-compaction).
// Every notice and every deny is one row in telemetry handoff-limit.jsonl; the daily usage report's Efficiency block counts them.

import { isHoldActive, holdWaitText } from './release-watch-state.mjs';
import { openSync, fstatSync, readSync, closeSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { opt } from './context.mjs';
import { readStamp, writeStamp, HANDOFF_RETURN, HANDOFF_FIELDS, kTokens } from './subagent-context.mjs';

export const HANDOFF_LOG = 'handoff-limit.jsonl';
export const HANDOFF_SOFT_DEFAULT = 110000;
export const HANDOFF_REPEAT_DEFAULT = 15000;
export const HANDOFF_HARD_DEFAULT = 150000;
export const WARN_DEFAULT = 110000;         // 0.31.65: warn (keep the handoff file current), every rung
export const HANDOFF_HIGH_DEFAULT = 130000; // 0.31.65: hand off, for the higher rungs (sonnet high and xhigh, the opus rungs)

// The higher rungs carry more context per step and re-read less, so they hand off later (operator decision 2026-11-23).
// A bare or plugin-prefixed agent type.
export const isHighRung = (agentType) => /^(ac-sonnet-(high|xhigh)|ac-opus-[a-z]+)$/.test(String(agentType || '').toLowerCase().replace(/^[^:]*:/, ''));

// The handoff notice line for this agent type: subagent_context_notice_tokens for the lower rungs, subagent_context_notice_high_tokens
// for the higher rungs (a high value of 0 or less falls back to the lower rungs' line); 0 on the base option = no notice at all.
export function handoffThreshold(agentType) {
  const base = Number(opt('subagent_context_notice_tokens', 110000));
  if (!(base > 0)) return 0;
  if (!isHighRung(agentType)) return base;
  const high = Number(opt('subagent_context_notice_high_tokens', HANDOFF_HIGH_DEFAULT));
  if (!(high > 0)) return base;
  // The higher rungs never hand off earlier than the lower ones (a raised base lifts them too), and a notice line at or past the hard
  // stop would never be heard (the hard deny comes first): then the base line stands.
  const t = Math.max(base, high);
  const hard = Number(opt('subagent_context_hard_tokens', HANDOFF_HARD_DEFAULT));
  return hard > 0 && t >= hard ? base : t;
}

// The warn line (subagent_context_warn_tokens, 0 = none). It applies only below the handoff line: where the two coincide there is
// just the handoff notice.
export function warnThreshold(agentType) {
  const w = Number(opt('subagent_context_warn_tokens', WARN_DEFAULT));
  const h = handoffThreshold(agentType);
  return w > 0 && h > 0 && w < h ? w : 0;
}

// The warn text: advice, once.
export function warnText(ctx, handoff, hard, variant = 'writer') {
  const lines = `handoff notice at ${kTokens(handoff)}${hard ? `, hard stop at ${kTokens(hard)}` : ''}`;
  if (variant === 'readonly') return `[agent-companion] Context at ${kTokens(ctx)} (${lines}): keep your findings so far in your detail file, so a handoff at any moment loses nothing.`;
  return `[agent-companion] Context at ${kTokens(ctx)} (${lines}): keep your handoff file <task>-handoff.md next to your detail file current (${HANDOFF_FIELDS}), so a handoff at any moment loses nothing.`;
}

// The settings, read once per hook run. `soft` is subagent_context_notice_tokens (0 = no notice), `hard` 0 = no deny.
export function handoffConfig(soft) {
  const num = (k, d) => { const n = Number(opt(k, d)); return Number.isFinite(n) && n > 0 ? n : 0; };
  return {
    on: opt('subagent_handoff_limits', true) !== false,
    soft: Number(soft) > 0 ? Number(soft) : 0,
    repeat: num('subagent_context_notice_repeat_tokens', HANDOFF_REPEAT_DEFAULT),
    hard: num('subagent_context_hard_tokens', HANDOFF_HARD_DEFAULT),
    held: isHoldActive(), // post-release hold: the hard limit counts as 0, so the next call is refused
    exempt: String(opt('subagent_handoff_exempt_types', '')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

// The agent type with or without its plugin prefix ("agent-companion:ac-haiku" matches "ac-haiku" and itself).
export function isExempt(agentType, exempt) {
  if (!exempt || !exempt.length) return false;
  const full = String(agentType || '').toLowerCase();
  if (!full) return false;
  const bare = full.replace(/^[^:]*:/, '');
  return exempt.includes(full) || exempt.includes(bare);
}

// Is the handoff mechanism in force for this worker? (The compaction note does not depend on it.)
export const handoffActive = (cfg, agentType) => cfg.on && (cfg.held || !isExempt(agentType, cfg.exempt));

// --- Repeat notices ------------------------------------------------------------------------------
const lastKey = (agentId) => `handoff-last-${agentId}`;

// Called with the first notice of a worker: remember the context it was told at.
export function noteFirst(agentId, ctx) {
  if (agentId && Number.isFinite(ctx)) writeStamp(lastKey(agentId), { last: ctx });
}

// True when the worker was already told and its context has grown `repeat` tokens past the level of its last notice.
// With no stamp (the first notice predates the stamp) the first level is the soft line itself.
export function repeatDue(agentId, ctx, soft, repeat) {
  if (!(repeat > 0) || !(soft > 0) || !agentId || typeof ctx !== 'number' || ctx < soft) return false;
  const st = readStamp(lastKey(agentId));
  const last = st && Number.isFinite(st.last) ? st.last : soft;
  if (ctx < last) { writeStamp(lastKey(agentId), { last: Math.max(ctx, soft) }); return false; } // it compacted: count again from here
  if (ctx < last + repeat) return false;
  writeStamp(lastKey(agentId), { last: ctx });
  return true;
}

// --- Text ------------------------------------------------------------------------------------------
export const DENY_STREAK_TEXT = 5; // denied calls in a row from which the reason says so
export const streakPrefix = (n) => (n >= DENY_STREAK_TEXT ? `${n} calls refused: write the handoff now or give your final reply. ` : '');

// `why`: for a refused Bash/PowerShell command, the specific reason (gitCheck); null for every other tool.
export function denyText(ctx, hard, variant = 'writer', why = null, held = false) {
  const head = held
    ? '[agent-companion] A post-release hold is on: work is paused and this call is blocked, and so is every call except the handoff. '
      + holdWaitText('subagent')
      + (why ? `Bash and PowerShell allow only plain git add/commit/push/status/diff/log; this command was refused: ${why}. ` : '')
    : `[agent-companion] Context at ${kTokens(ctx)} is past the hard limit of ${kTokens(hard)}: this call is blocked, and so is every call except the handoff. `
    + (why ? `Bash and PowerShell allow only plain git add/commit/push/status/diff/log (no pipe, redirect, backtick, $(...) or other command, and only the listed options); this command was refused: ${why}. ` : '');
  if (variant === 'readonly') {
    return `${head}Write what you have to a file with "handoff" in its name next to your detail file (<task>-handoff.md), or put it in your final reply, then end with "${HANDOFF_RETURN}". Allowed: Write, Edit or Read of a .md file whose name contains "handoff". Everything else, including starting agents, stays blocked.`
    + (held ? ' If a push is refused because a pre-push gate runs through the shared queue (it is held too), commit, write the handoff file and say the push is pending.' : '');
  }
  return `${head}Finish: commit and push any work in progress to your branch (git add, commit, push, status, diff and log are allowed), write a handoff file <task>-handoff.md next to your detail file (${HANDOFF_FIELDS}; Write, Edit and Read of a .md file whose name contains "handoff" are allowed), then end with "${HANDOFF_RETURN}". Everything else, including starting agents, stays blocked.`;
}

// Consecutive denied calls of one agent (reset by any call the hard limit lets through), so a worker that keeps retrying is told to stop.
const denyKey = (agentId) => `handoff-denies-${agentId}`;
export function noteDeny(agentId) {
  if (!agentId) return 1;
  const st = readStamp(denyKey(agentId));
  const n = (st && Number.isFinite(st.n) ? st.n : 0) + 1;
  writeStamp(denyKey(agentId), { n });
  return n;
}
export function clearDeny(agentId) {
  if (!agentId) return;
  const st = readStamp(denyKey(agentId));
  if (st && st.n > 0) writeStamp(denyKey(agentId), { n: 0 });
}

// --- What the hard limit lets through ----------------------------------------------------------------
// A file the handoff may touch: the basename contains "handoff" and ends in .md (a handoff file, not any source file with the word in it).
const nameOf = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase();
export const isHandoffPath = (p) => typeof p === 'string' && nameOf(p).includes('handoff') && nameOf(p).endsWith('.md');

// The usual commit message in a heredoc, accepted in ONE shape only, anchored on the whole command:
//   <anything scanned like the rest> -m "$(cat <<'DELIM'<NL> body <NL>DELIM<NL>)"   end of command
// The delimiter must be quoted (the body is then literal text, never expanded), nothing but blanks follows it on the opening line, the closing
// line is the only line in the whole command equal to the delimiter, and only `)"` follows it. The whole thing becomes the message "x".
const HEREDOC = /^([\s\S]*?\s-m[ \t]+)"\$\(cat <<(['"])([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*\n[\s\S]*?\n\3\n\)"[ \t\r\n]*$/;

// Splits a command into segments of words (&&, ||, ; and newlines separate them). Returns { segs } or { why }. Refused outside quotes: pipes,
// redirects, a lone &, $, backticks, ( ) { } (substitution, expansion, subshell, brace expansion), # (comment), a backslash that starts a word
// or ends a line. Inside "..." no $, backtick or backslash; inside '...' anything. Each word keeps its quote kind ('single', 'double', or null
// for bare or mixed) because a commit message must be one quoted literal.
function scan(s) {
  const segs = [];
  let words = [];
  let w = null;
  const piece = (kind, text) => {
    if (!w) w = { v: '', kinds: [] };
    w.v += text;
    if (kind !== 'bare' || w.kinds[w.kinds.length - 1] !== 'bare') w.kinds.push(kind);
  };
  const endWord = () => {
    if (w) words.push({ v: w.v, quoted: w.kinds.length === 1 && w.kinds[0] !== 'bare' ? w.kinds[0] : null });
    w = null;
  };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return { why: 'unterminated quote' };
      piece('single', s.slice(i + 1, j));
      i = j;
    } else if (c === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) return { why: 'unterminated quote' };
      const t = s.slice(i + 1, j);
      if (/[$`\\]/.test(t)) return { why: 'a "..." string with $, a backtick or a backslash (use single quotes)' };
      piece('double', t);
      i = j;
    } else if (c === ' ' || c === '\t') endWord();
    else if (c === ';' || c === '\n' || c === '\r') endSeg();
    else if (c === '&') { if (n !== '&') return { why: 'background & is not allowed' }; endSeg(); i += 1; }
    else if (c === '|') { if (n !== '|') return { why: 'a pipe is not allowed' }; endSeg(); i += 1; }
    else if (c === '<' || c === '>') return { why: 'a redirect or heredoc outside the one allowed commit-message form' };
    else if (c === '`' || c === '$' || c === '(' || c === ')' || c === '{' || c === '}') return { why: `"${c}" (command substitution, expansion or subshell) is not allowed` };
    else if (c === '#' && !w) return { why: 'a comment is not allowed' };
    else if (c === '\\') {
      if (!w || n === undefined || n === '\n' || n === '\r') return { why: 'a backslash escape is not allowed here' };
      piece('bare', c + n);
      i += 1;
    } else piece('bare', c);
  }
  endSeg();
  return { segs };
}

// The options each verb may carry, and nothing else (default-deny: git also accepts shortened long options, so a list of bad ones would leak).
// Also allowed: commit -m '<text>' and -F <handoff .md>, log -n <N> and -<N>, `--` before paths.
const FLAGS = {
  add: ['-A', '--all', '-u'],
  commit: ['-a'],
  push: ['-u', '--set-upstream'],
  status: ['-s', '--short', '-b', '--branch', '--porcelain'],
  diff: ['--stat', '--cached', '--staged', '--name-only', '--name-status'],
  log: ['--oneline', '--stat'],
};
// Named only for a clearer message: force, delete, mirror, command execution, file output, no-index, global config and repository options.
const NEVER = /^(?:--force|--delete$|--receive-pack|--exec|--mirror|--git-dir|--work-tree|--output|--no-index|--ext-diff|--textconv|-f$|-d$|-D$|-c$)/;
const REMOTE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const clip = (x) => String(x).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60);

// A path or ref given to diff or log: no absolute path, no `..` segment (`git diff <path> <path>` on paths outside the work tree is --no-index).
function outsidePath(v) {
  if (/^([\\/~]|[A-Za-z]:)/.test(v)) return true;
  return [v, v.replace(/\\/g, '')].some((x) => x.split(/[\\/]/).includes('..'));
}

function checkGit(v, words) {
  let i = 1;
  while (i < v.length) {
    if (v[i] === '-C') { if (v[i + 1] === undefined) return 'git -C needs a path'; i += 2; } else if (v[i] === '--no-pager') i += 1; else break;
  }
  const verb = v[i];
  if (!FLAGS[verb]) return verb === undefined ? 'git with no command' : `git ${clip(verb)} is not allowed (only git add, commit, push, status, diff, log; no -c, --git-dir or other global option)`;
  const args = words.slice(i + 1);
  const flags = FLAGS[verb];
  const pos = [];
  let rest = false;
  let msg = false;
  for (let k = 0; k < args.length; k += 1) {
    const t = args[k].v;
    if (rest) { pos.push(t); continue; }
    if (t === '--') { rest = true; continue; }
    if (verb === 'commit' && (t === '-m' || t === '-F')) {
      const nx = args[k + 1];
      if (!nx) return `git commit ${t} needs a value`;
      if (t === '-m' && !nx.quoted) return "the commit message must be one quoted literal: -m '<text>' or -m \"<text>\" (no $, backtick or backslash inside double quotes), or the heredoc form with a quoted delimiter (<<'EOF')";
      if (t === '-F' && !isHandoffPath(nx.v)) return 'git commit -F is allowed only for a .md file whose name contains "handoff"';
      msg = true;
      k += 1;
      continue;
    }
    if (verb === 'log' && t === '-n') {
      const nx = args[k + 1];
      if (!nx || !/^\d{1,6}$/.test(nx.v)) return 'git log -n needs a number';
      k += 1;
      continue;
    }
    if (t.length > 1 && t[0] === '-') {
      if (flags.includes(t) || (verb === 'log' && /^-\d{1,6}$/.test(t))) continue;
      return NEVER.test(t)
        ? `git ${verb} option ${clip(t)} is not allowed`
        : `git ${verb} option ${clip(t)} is not on the allowed list (${flags.join(' ')}${verb === 'commit' ? ' -m -F' : ''}${verb === 'log' ? ' -n <N> -<N>' : ''})`;
    }
    pos.push(t);
  }
  if (verb === 'commit') {
    if (!msg) return "git commit needs -m '<message>' (or -F <handoff file>)";
    if (pos.length) return 'git commit takes no paths here (git add them first)';
  }
  if (verb === 'push') {
    if (pos.length > 2) return 'git push takes at most a remote name and a branch';
    if (pos[0] !== undefined && !REMOTE.test(pos[0])) return `git push remote "${clip(pos[0])}" must be a plain remote name`;
    const ref = pos[1];
    if (ref !== undefined && ref !== 'HEAD' && !BRANCH.test(ref) && !(ref.startsWith('HEAD:') && BRANCH.test(ref.slice(5)))) {
      return `git push ref "${clip(ref)}" must be a branch name, HEAD or HEAD:<branch> (no + and no leading :)`;
    }
  }
  if ((verb === 'diff' || verb === 'log') && pos.some(outsidePath)) return `git ${verb}: no absolute path and no .. in a path or ref`;
  return null;
}

function checkSegment(words) {
  const v = words.map((x) => x.v);
  if (v[0] === 'cd') return v.length === 2 ? null : 'cd takes exactly one path';
  if (v[0] !== 'git') return `"${clip(v[0])}" is not git`;
  return checkGit(v, words);
}

// null when the whole command is plain git add, commit, push, status, diff or log (a leading `cd <path>` is a no-op and passes), joined by &&, ||, ; or
// newlines, with only the options allowed per verb (FLAGS above); otherwise the reason it was refused. Any pipe, redirect, background &, command
// substitution or backtick is refused; a commit message is one quoted literal, a quoted-delimiter heredoc in the one anchored shape, or -F <handoff .md>.
export function gitCheck(command) {
  if (typeof command !== 'string' || !command.trim()) return 'empty command';
  if (command.length > 20000) return 'the command is too long';
  let s = command;
  const h = HEREDOC.exec(command);
  if (h) {
    if (command.split('\n').filter((l) => l === h[3]).length !== 1) return 'the heredoc delimiter line must appear exactly once, as the closing line';
    s = `${h[1]}"x"`;
  }
  const sc = scan(s);
  if (!sc.segs) return sc.why;
  if (!sc.segs.length) return 'empty command';
  for (const seg of sc.segs) { const why = checkSegment(seg); if (why) return why; }
  return null;
}
export const gitOnly = (command) => gitCheck(command) === null;

// Why a call would be refused past the hard limit: null when it passes, else a string (for Bash and PowerShell the specific reason).
export function refusal(p) {
  const name = String((p && p.tool_name) || '');
  const input = (p && p.tool_input && typeof p.tool_input === 'object') ? p.tool_input : {};
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'Read') return isHandoffPath(input.file_path) ? null : 'not a handoff .md file';
  if (name === 'Bash' || name === 'PowerShell') return gitCheck(input.command);
  return 'not allowed';
}
export const allowedAtHard = (p) => refusal(p) === null;

// --- The lead side: a worker that handed off ---------------------------------------------------------------
// The path in a final message that ends "DONE: partial, handoff at <path>" (the last such line wins), else null. The text is the worker's own,
// so it goes into the lead's context cleaned: control characters removed, at most 300 characters.
export const HANDOFF_PATH_MAX = 300;
// 0.31.61 review: only the final non-empty line counts (a quoted rule mid-message never does), the path has no <>"'|*? and ends in .md,
// is a handoff file (isHandoffPath), and exists on disk (a relative path resolves against cwd).
export function handoffReturnPath(msg, cwd) {
  const lines = String(msg || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const m = /^(?:\*\*)?DONE:\s*partial,\s*handoff at\s+`?([^`<>"'|*?\r\n]+?\.md)`?\.?(?:\*\*)?$/i.exec(last);
  if (!m) return null;
  const path = m[1].replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, HANDOFF_PATH_MAX);
  if (!isHandoffPath(path)) return null;
  try { return existsSync(isAbsolute(path) ? path : resolve(cwd || process.cwd(), path)) ? path : null; } catch { return null; }
}

// What the lead is told, once, when that worker ends: continue at once, with a fresh worker, no resume.
export function handoffContinueText(agentType, agentId, path, model) {
  const type = agentType || 'the same agent type';
  return `[agent-companion] subagent ${type}${agentId ? ` (${String(agentId).slice(0, 12)})` : ''} handed off: "DONE: partial, handoff at ${path}". `
    + `Spawn a fresh worker of the same agent type (${type})${model ? ` and model (${model})` : ''} right away, with that file as its brief: tell it to read ${path} first and carry on from its exact next step. `
    + 'A new spawn, not a resume (SendMessage would re-read the whole context on every call).';
}

// --- The end-of-run guard ------------------------------------------------------------------------------------
// A worker past the soft limit that is about to end without a completed STATUS and without having written a handoff file would lose its
// context for good: SubagentStop asks it ONCE (per agent id, so it can never loop) to write the handoff first.
// "Completed": a final message with STATUS: done, VERDICT: PASS or VERDICT: FIX (a reviewer's finished verdict), or DONE: without "partial".
// "Handed off": DONE: partial with a path, or a handoff file.
export function finalIsComplete(msg) {
  const t = String(msg || '');
  if (/\bSTATUS:\s*done\b/i.test(t) || /\bVERDICT:\s*(?:PASS|FIX)\b/i.test(t)) return true;
  return /\bDONE:(?!\s*partial\b)/i.test(t);
}

// Did this worker write a handoff file? Reads the last 4 MB of its transcript only. Counted: a Write, Edit or MultiEdit tool_use whose file is a
// handoff .md (isHandoffPath) and whose tool_result is not an error (a result that is not in the tail does not count against it). A Read never counts.
export function handoffFileWritten(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const writes = new Map(); // tool_use id -> true
    const failed = new Set();
    let anonymous = false;
    for (const l of buf.toString('utf8').split('\n')) {
      const use = l.includes('"tool_use"');
      if (!use && !l.includes('"tool_result"')) continue;
      let o;
      try { o = JSON.parse(l); } catch { continue; } // a torn first line of the tail, or garbage
      const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'tool_use' && ['Write', 'Edit', 'MultiEdit'].includes(c.name) && c.input && isHandoffPath(c.input.file_path)) {
          if (c.id) writes.set(c.id, true); else anonymous = true;
        } else if (c.type === 'tool_result' && c.is_error === true && c.tool_use_id) failed.add(c.tool_use_id);
      }
    }
    return anonymous || [...writes.keys()].some((id) => !failed.has(id));
  } catch { return false; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}

export function endGuardText(variant = 'writer') {
  if (variant === 'readonly') {
    return `[agent-companion] Your context is past the handoff line and you have not handed off. Before you end: write what you have (findings so far, what is left, the exact next step) to a file with "handoff" in its name next to your detail file (<task>-handoff.md), then end with "${HANDOFF_RETURN}".`;
  }
  return `[agent-companion] Your context is past the handoff line and you have not handed off. Before you end: commit and push any work in progress to your branch, write a handoff file <task>-handoff.md next to your detail file (${HANDOFF_FIELDS}), then end with "${HANDOFF_RETURN}".`;
}

// --- The hard check and the log row ----------------------------------------------------------------------
export function handoffRow(p, sig, limit, action, limitTokens) {
  return {
    at: new Date().toISOString(), session_id: p.session_id, agent_id: p.agent_id, agent_type: p.agent_type,
    model: sig.model || null, tokens: sig.ctx, limit, limit_tokens: limitTokens, action,
    ...(action === 'deny' ? { tool: p.tool_name || null } : {}),
  };
}

// null: nothing to do. { row, why } : deny this call (`why`: the Bash reason, else null). Cheap exits first. A compaction with no request after it
// yet leaves ctx at its pre-compaction size, so it never denies.
export function hardCheck(p, sig, cfg) {
  if (!cfg.on) return null;
  const held = !!cfg.held;
  if (!held && (!(cfg.hard > 0) || !sig || typeof sig.ctx !== 'number' || sig.ctx < cfg.hard)) return null;
  if (!held && sig.boundary && sig.turnsAfterBoundary === 0) return null;
  if (!held && isExempt(p.agent_type, cfg.exempt)) return null;
  const why = refusal(p);
  if (why === null) return null;
  const bash = p.tool_name === 'Bash' || p.tool_name === 'PowerShell';
  return { row: handoffRow(p, sig || {}, held ? 'hold' : 'hard' /* N6: row limit 'hold' stands for the spec's reason release-hold; the hold is not tied to a version, only the operator's clear lifts it */, 'deny', held ? 0 : cfg.hard), why: bash ? why : null, held };
}
