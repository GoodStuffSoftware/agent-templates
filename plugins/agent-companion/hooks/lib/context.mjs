// Shared helpers for agent-companion hooks.
//
// Design rule that outranks every feature here: A HOOK MUST NEVER BREAK A SESSION.
// Every guard fails OPEN. If we cannot parse the payload, cannot read state, or
// cannot positively confirm we are on the main thread, we allow the call. The
// cost of under-enforcing is a missed nudge; the cost of over-enforcing is a
// wedged agent. The daily calibration routine is what catches under-enforcement.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
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
    let raw = readFileSync(0, 'utf8') || '';
    // PowerShell prepends a UTF-8 BOM to piped stdin on Windows. Without this
    // strip, JSON.parse throws, the caller's fail-open catch swallows it, and
    // the hook silently does nothing — indistinguishable from "no issues
    // found". Documented in the library as powershell-pipe-bom-breaks-json.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    raw = raw.trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const DATA_ROOT = join(homedir(), '.claude', 'plugins', 'data');

// Inside a hook the harness sets CLAUDE_PLUGIN_DATA and this is exact. The
// fallback matters for READERS — the audit, the doctor, the scout — which run
// outside a hook. It previously guessed `data/agent-companion`, but the real
// convention is `data/<plugin>-<marketplace>`, so every reader was scanning a
// directory that did not exist and reporting a clean bill of health against
// nothing at all. A silent wrong answer, which is the failure this plugin is
// supposed to catch, not commit.
export function dataDir() {
  const d = process.env.CLAUDE_PLUGIN_DATA || dataDirs()[0]
    || join(DATA_ROOT, 'agent-companion-agent-templates');
  try { mkdirSync(d, { recursive: true }); } catch { /* fail open */ }
  return d;
}

// The same plugin can accumulate SEVERAL data directories — one per marketplace
// it was loaded from, plus `-inline` for a dev/--plugin-dir load. Telemetry
// splits across them, so a reader that looks at only one under-reports without
// any sign that it did. Readers should aggregate across all of them.
export function dataDirs() {
  try {
    return readdirSync(DATA_ROOT)
      .filter((d) => d === 'agent-companion' || d.startsWith('agent-companion-'))
      .map((d) => join(DATA_ROOT, d))
      .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
  } catch {
    return [];
  }
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

// Look up a named agent's own definition. This is what distinguishes a
// PROJECT-DEFINED agent from genuine harness drift, and a configured model from
// an unexamined default — the two things the raw payload cannot tell apart.
export function agentDefinition(type, cwd) {
  if (!type) return null;
  const roots = [
    cwd && join(cwd, '.claude', 'agents'),
    join(homedir(), '.claude', 'agents'),
  ].filter(Boolean);
  for (const root of roots) {
    const file = join(root, `${type}.md`);
    try {
      if (!existsSync(file)) continue;
      const m = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) return { file, model: '', effort: '' };
      const fm = {};
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (kv) fm[kv[1]] = kv[2].trim();
      }
      return { file, model: fm.model || '', effort: fm.effort || '' };
    } catch { /* keep looking */ }
  }
  return null;
}

// Enforcement fails open on unknown types, but detection must not. Record them
// so the daily scout can dispatch a harness-surface review.
//
// Two refinements learned from real data: a type with its own definition file
// is a PROJECT-DEFINED agent, not drift — recording those buried the real signal
// under a project's own roster. And the same type was appended dozens of times
// in an afternoon; drift is a set, not a stream, so each type is recorded once.
export function noteAgentType(p) {
  const t = p.agent_type;
  if (!t || KNOWN_AGENT_TYPES.has(t)) return;
  if (agentDefinition(t, p.cwd)) return; // defined somewhere: known, not drift
  try {
    const f = join(dataDir(), 'unknown-agent-types.jsonl');
    let seen = '';
    try { seen = readFileSync(f, 'utf8'); } catch { /* first one */ }
    if (seen.includes(`"agent_type":"${t}"`)) return;
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

// Emitted telemetry is a PUBLIC CONTRACT, not an internal detail — other tools
// read these files. Every record carries the schema version that produced it, so
// a consumer can skip records from a major version it does not understand
// instead of silently misreading them. Consumers must tolerate unknown fields.
// See docs/TELEMETRY.md.
export const TELEMETRY_SCHEMA = 1;

export function appendLog(name, record) {
  try {
    const stamped = { v: TELEMETRY_SCHEMA, ...record };
    writeFileSync(stateFile(name), JSON.stringify(stamped) + '\n', { flag: 'a' });
  } catch { /* fail open */ }
}

// Record a guard firing. Without this the denial count is always zero, and a
// guard that has silently stopped matching is indistinguishable from one with
// nothing to deny — which is exactly the signal the calibration canary exists
// to raise. Call this BEFORE deny(), which exits the process.
export function recordDenial(guard, payload, detail) {
  const sid = String(payload?.session_id ?? '');
  if (sid.startsWith('canary')) return; // probes must not inflate their own metric
  appendLog('denials.jsonl', {
    at: new Date().toISOString(),
    session_id: sid,
    agent_type: payload?.agent_type,
    guard,
    outcome: 'deny',
    detail: String(detail ?? '').slice(0, 300),
  });
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
