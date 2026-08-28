// Shared helpers for agent-companion hooks.
//
// Design rule that outranks every feature here: A HOOK MUST NEVER BREAK A SESSION.
// Every guard fails OPEN. If we cannot parse the payload, cannot read state, or
// cannot positively confirm we are on the main thread, we allow the call. The
// cost of under-enforcing is a missed nudge; the cost of over-enforcing is a
// wedged agent. The daily calibration routine is what catches under-enforcement.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Agent types observed in the shipped binary (2.1.220). The binary tests the
// main thread with `agentType === "main"`, but mainThreadAgentType is settable
// at runtime, so we treat this as an allowlist rather than a guarantee.
export const MAIN_THREAD_TYPES = new Set(['main', 'main-session']);
export const KNOWN_AGENT_TYPES = new Set([
  'main', 'main-session', 'subagent', 'teammate', 'worker',
  'workflow-subagent', 'general-purpose', 'claude', 'statusline-setup',
  'Explore', 'Plan', 'claude-code-guide',
]);

// Premium tiers. Fable is deliberately NOT banned — it is capped and audited.
export const PREMIUM_MODELS = [/fable/i, /opus/i];

export function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

export function dataDir() {
  const d = process.env.CLAUDE_PLUGIN_DATA
    || join(homedir(), '.claude', 'plugins', 'data', 'agent-companion');
  try { mkdirSync(d, { recursive: true }); } catch { /* fail open */ }
  return d;
}

// userConfig keys surface as CLAUDE_PLUGIN_OPTION_<KEY> env vars.
export function opt(key, fallback) {
  const raw = process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  if (raw === undefined || raw === '') return fallback;
  if (typeof fallback === 'boolean') return !/^(false|0|no|off)$/i.test(raw);
  if (typeof fallback === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  return raw;
}

// Positive confirmation only. Unknown or missing => NOT main => no enforcement.
export function isMainThread(p) {
  return typeof p.agent_type === 'string' && MAIN_THREAD_TYPES.has(p.agent_type);
}

// Enforcement fails open on unknown types, but detection must not. Record them
// so the daily scout can dispatch a harness-surface review.
export function noteAgentType(p) {
  const t = p.agent_type;
  if (!t || KNOWN_AGENT_TYPES.has(t)) return;
  try {
    const f = join(dataDir(), 'unknown-agent-types.jsonl');
    writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), agent_type: t }) + '\n', { flag: 'a' });
  } catch { /* fail open */ }
}

export function isPremium(model) {
  return typeof model === 'string' && PREMIUM_MODELS.some((re) => re.test(model));
}

export function stateFile(name) {
  return join(dataDir(), name);
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  try { writeFileSync(file, JSON.stringify(value)); } catch { /* fail open */ }
}

export function appendLog(name, record) {
  try {
    writeFileSync(stateFile(name), JSON.stringify(record) + '\n', { flag: 'a' });
  } catch { /* fail open */ }
}

export function allow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  }));
  process.exit(0);
}

export function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// Exit silently without a decision — the call proceeds normally.
export function passthrough() { process.exit(0); }
