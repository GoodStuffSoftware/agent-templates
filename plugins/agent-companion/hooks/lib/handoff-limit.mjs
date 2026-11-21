// Worker handoff limits (0.31.60): the enforcement half of the subagent context notice.
//
// What was missing. The size notice (lib/subagent-context.mjs) is advice, once, and a worker can ignore it; the optional
// ceiling (lib/context-ceiling.mjs) is advice too and is off. Nothing kept a worker from running to the ~217K
// auto-compaction. This adds, on the SAME hook and the SAME transcript reading (hooks/subagent-context.mjs, PreToolUse,
// subagents only; the lead is never touched):
//   soft limit  (option subagent_context_notice_tokens, default 110000)  the notice, then again every
//               subagent_context_notice_repeat_tokens (default 15000) while the context keeps growing
//   hard limit  (option subagent_context_hard_tokens, default 150000)    a PreToolUse deny of everything except what a handoff
//               needs: Write/Edit/Read of a file whose name contains "handoff", and Bash/PowerShell that is only git add,
//               commit, push, status, diff or log (cd to a path is allowed in front of them)
//   switch      subagent_handoff_limits (default on); exemptions subagent_handoff_exempt_types (comma list, default empty)
// Switch off, or an exempt agent type: the whole handoff mechanism (notice, repeats, deny) does nothing for that worker;
// the compaction note is separate and unchanged. Any error: do nothing (the hook fails open).
//
// Defaults and why (operator decision 2026-11; usage review: calls over 150K were about 40% of subagent cost, and the
// longest workers ran 135-206 calls up to 209-217K context before the auto-compaction).
// Every notice and every deny is one row in telemetry handoff-limit.jsonl; the daily usage report's Efficiency block counts them.

import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { opt } from './context.mjs';
import { readStamp, writeStamp, HANDOFF_RETURN, HANDOFF_FIELDS, kTokens } from './subagent-context.mjs';

export const HANDOFF_LOG = 'handoff-limit.jsonl';
export const HANDOFF_SOFT_DEFAULT = 110000;
export const HANDOFF_REPEAT_DEFAULT = 15000;
export const HANDOFF_HARD_DEFAULT = 150000;

// The settings, read once per hook run. `soft` is subagent_context_notice_tokens (0 = no notice), `hard` 0 = no deny.
export function handoffConfig(soft) {
  const num = (k, d) => { const n = Number(opt(k, d)); return Number.isFinite(n) && n > 0 ? n : 0; };
  return {
    on: opt('subagent_handoff_limits', true) !== false,
    soft: Number(soft) > 0 ? Number(soft) : 0,
    repeat: num('subagent_context_notice_repeat_tokens', HANDOFF_REPEAT_DEFAULT),
    hard: num('subagent_context_hard_tokens', HANDOFF_HARD_DEFAULT),
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
export const handoffActive = (cfg, agentType) => cfg.on && !isExempt(agentType, cfg.exempt);

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
export function denyText(ctx, hard, variant = 'writer') {
  const head = `[agent-companion] Context at ${kTokens(ctx)} is past the hard limit of ${kTokens(hard)}: this call is blocked, and so is every call except the handoff. `;
  if (variant === 'readonly') {
    return `${head}Write what you have to a file with "handoff" in its name next to your detail file (<task>-handoff.md), or put it in your final reply, then end with "${HANDOFF_RETURN}". Allowed: Write, Edit or Read of a file whose name contains "handoff". Everything else, including starting agents, stays blocked.`;
  }
  return `${head}Finish: commit and push any work in progress to your branch (git add, commit, push, status, diff and log are allowed), write a handoff file <task>-handoff.md next to your detail file (${HANDOFF_FIELDS}; Write, Edit and Read of a file whose name contains "handoff" are allowed), then end with "${HANDOFF_RETURN}". Everything else, including starting agents, stays blocked.`;
}

// --- What the hard limit lets through ----------------------------------------------------------------
const nameOf = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase();
export const isHandoffPath = (p) => typeof p === 'string' && nameOf(p).includes('handoff');

// "$(cat <<'EOF' ... EOF )": the usual way to pass a commit message. Its body is quoted text, not commands.
const HEREDOC_SUBST = /\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*\n?\s*\)/g;
const ARG = '(?:"[^"]*"|\'[^\']*\'|\\S+)';
const SEGMENT = new RegExp(`^(?:cd\\s+${ARG}|git(?:\\s+-C\\s+${ARG}|\\s+--no-pager)*\\s+(?:add|commit|push|status|diff|log)(?:\\s.*)?)$`);

// True only when the whole command is git add, commit, push, status, diff or log (a leading `cd <path>` is a no-op and passes),
// joined by &&, || or ; or newlines. Any pipe, redirect, background &, command substitution or backtick outside single quotes is refused.
export function gitOnly(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 20000) return false;
  const s = command.replace(HEREDOC_SUBST, '"x"');
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    const n = s[i + 1];
    if (q === "'") { if (c === "'") q = null; cur += c; continue; }
    if (q === '"') {
      if (c === '\\') { cur += c + (n ?? ''); i += 1; continue; }
      if (c === '`' || (c === '$' && n === '(')) return false;
      if (c === '"') q = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (n ?? ''); i += 1; continue; }
    if (c === '`' || (c === '$' && n === '(') || c === '>' || c === '<') return false;
    if (c === '&') { if (n !== '&') return false; segs.push(cur); cur = ''; i += 1; continue; }
    if (c === '|') { if (n !== '|') return false; segs.push(cur); cur = ''; i += 1; continue; }
    if (c === ';' || c === '\n' || c === '\r') { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (q) return false;
  segs.push(cur);
  const parts = segs.map((x) => x.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((x) => SEGMENT.test(x));
}

// May this tool call go through past the hard limit?
export function allowedAtHard(p) {
  const name = String((p && p.tool_name) || '');
  const input = (p && p.tool_input && typeof p.tool_input === 'object') ? p.tool_input : {};
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'Read') return isHandoffPath(input.file_path);
  if (name === 'Bash' || name === 'PowerShell') return gitOnly(input.command);
  return false;
}

// --- The lead side: a worker that handed off ---------------------------------------------------------------
// The path in a final message that ends "DONE: partial, handoff at <path>" (the last such line wins), else null.
export function handoffReturnPath(msg) {
  const m = [...String(msg || '').matchAll(/DONE:\s*partial,\s*handoff at\s+([^\r\n]+)/gi)].pop();
  if (!m) return null;
  const path = m[1].trim().replace(/^[`"'<(]+|[`"'>).\s]+$/g, '');
  return path && path !== 'path' ? path : null;
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
// "Completed": a final message with STATUS: done, or DONE: without "partial". "Handed off": DONE: partial with a path, or a handoff file.
export function finalIsComplete(msg) {
  const t = String(msg || '');
  if (/\bSTATUS:\s*done\b/i.test(t)) return true;
  return /\bDONE:(?!\s*partial\b)/i.test(t);
}

// Did this worker write (Write or Edit) a file whose name contains "handoff"? Reads the last 4 MB of its transcript only.
export function handoffFileWritten(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8').split('\n').some((l) => l.includes('"tool_use"') && /"file_path":\s*"[^"]*handoff[^"]*"/i.test(l));
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

// null: nothing to do. { row } : deny this call. Cheap exits first. A compaction with no request after it yet leaves ctx at its
// pre-compaction size, so it never denies.
export function hardCheck(p, sig, cfg) {
  if (!cfg.on || !(cfg.hard > 0) || !sig || typeof sig.ctx !== 'number' || sig.ctx < cfg.hard) return null;
  if (sig.boundary && sig.turnsAfterBoundary === 0) return null;
  if (isExempt(p.agent_type, cfg.exempt)) return null;
  if (allowedAtHard(p)) return null;
  return { row: handoffRow(p, sig, 'hard', 'deny', cfg.hard) };
}
