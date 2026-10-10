// Live lead-effort check at a main session's first Agent spawn.
//
// get_session reports the effort a session was CREATED with; the PreToolUse
// payload of an Agent call carries the LIVE `effort.level` (the app's effort
// control moves it mid-session). The first spawn of a main session is the one
// place the plugin sees the real value, so the check runs there, once.
//
// The target follows the rollout: xhigh until the rollout named by the
// lead_effort_rollout_id option is reached, high from it; an empty option means
// always xhigh. This is the same switch the lead-effort-check wording uses.
//   live below target : one non-blocking note to the lead (additionalContext)
//   live above target : one operator-visible systemMessage; it asks the lead
//                       for nothing (a lead cannot change its own effort)
//   equal             : nothing
//
// Strictly additive. This module never allows, denies or rewrites a spawn: it
// only returns text for the two slots the spawn guard already has, plus two
// telemetry fields. Fail open everywhere.
//
// It runs only while the lead-effort-check rule is enabled (the rule states
// the house policy; a public install with the rule off is unchanged) and the
// `lead_effort_live_check` option is not false.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEffort, opt, rolloutActive, rolloutStartMs, stateDir } from './context.mjs';
import { leadEffortRolloutId, effectiveRule, readRules } from './rules.mjs';

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_MARKERS = 200;

// The target at `now` (omitted: the real clock, or AGENT_COMPANION_FAKE_NOW),
// and when it changed to high (ISO minute, or null before the switch).
export function leadEffortTargetNow(now) {
  const id = leadEffortRolloutId();
  if (!id || !rolloutActive(id, now)) return { target: 'xhigh', since: null };
  const ms = rolloutStartMs(id);
  const since = typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 16) + 'Z' : null;
  return { target: 'high', since };
}

function ruleEnabled() {
  try {
    const r = readRules().rules.find((x) => x.id === 'lead-effort-check');
    return !!r && effectiveRule(r).enabled === true;
  } catch {
    return false;
  }
}

// What to say for a live effort against a target. Pure; null for equal,
// unknown, or unreadable values.
export function leadEffortVerdict(live, targetInfo) {
  const l = classifyEffort(live);
  const t = classifyEffort(targetInfo.target);
  if (!live || !l.known || !t.known) return null;
  if (l.rank < t.rank) {
    return {
      kind: 'below',
      context:
        `agent-companion: this session's live effort is ${l.level} (read from the hook payload; get_session shows the effort the session was created at). ` +
        `The lead target is ${t.level}. You cannot change your own effort; the operator can, with the app's effort control. Not blocking.`,
    };
  }
  if (l.rank > t.rank) {
    return {
      kind: 'above',
      systemMessage:
        `agent-companion: this session runs at ${l.level}; the lead target is ${t.level}` +
        `${targetInfo.since ? ` since ${targetInfo.since}` : ''}. Informational only, nothing is asked of the lead.`,
    };
  }
  return null;
}

// One marker file per session, created exclusively: concurrent spawns of the
// same turn (separate hook processes) race on it and exactly one wins.
function claim(sid) {
  try {
    const dir = join(stateDir(), 'lead-effort-live');
    mkdirSync(dir, { recursive: true });
    prune(dir);
    const name = `${createHash('sha256').update(String(sid)).digest('hex').slice(0, 16)}.said`;
    writeFileSync(join(dir, name), new Date().toISOString(), { flag: 'wx' });
    return true;
  } catch {
    return false; // already said (EEXIST), or the state dir is unwritable: say nothing
  }
}

function prune(dir) {
  try {
    const now = Date.now();
    const files = readdirSync(dir).filter((f) => f.endsWith('.said')).map((f) => {
      try { return { f, t: statSync(join(dir, f)).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.t - a.t);
    files.forEach((x, i) => {
      if (i >= MAX_MARKERS || now - x.t > KEEP_MS) { try { unlinkSync(join(dir, x.f)); } catch { /* ignore */ } }
    });
  } catch { /* fail open */ }
}

let pending = null; // set by leadEffortLive(), read once by mergeLeadEffort()

// Called once per spawn, after the caller's live effort is known. Returns the
// two telemetry fields; the text is held until mergeLeadEffort() is called at
// the moment an allow is emitted (a denied first spawn does not use up the
// once-per-session note).
export function leadEffortLive({ sid, subagentCaller, callerEffort, isCanary }) {
  const none = { lead_effort_live: null, lead_effort_target: null };
  pending = null;
  try {
    if (subagentCaller || isCanary || !opt('lead_effort_live_check', true) || !ruleEnabled()) return none;
    const targetInfo = leadEffortTargetNow();
    const live = callerEffort ? String(callerEffort).toLowerCase() : null;
    const row = { lead_effort_live: live, lead_effort_target: targetInfo.target };
    const verdict = leadEffortVerdict(live, targetInfo);
    if (verdict) pending = { sid, verdict };
    return row;
  } catch {
    return none;
  }
}

// Adds the held text to the allow's two slots when this process wins the
// once-per-session claim. Returns the pair unchanged otherwise.
export function mergeLeadEffort(systemMessage, additionalContext) {
  const p = pending;
  if (!p) return { systemMessage, additionalContext };
  pending = null;
  if (!claim(p.sid)) return { systemMessage, additionalContext };
  const join2 = (a, b) => [a, b].filter((x) => typeof x === 'string' && x.trim()).join('\n\n') || a;
  return {
    systemMessage: p.verdict.systemMessage ? join2(systemMessage, p.verdict.systemMessage) : systemMessage,
    additionalContext: p.verdict.context ? join2(additionalContext, p.verdict.context) : additionalContext,
  };
}
