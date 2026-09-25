// Did the harness honour the spawn guard's ladder rewrite?
//
// When best-fit autofill picks a model for a general-purpose spawn, the guard
// may rewrite subagent_type to the matching ladder rung (hooks/spawn-guard.mjs)
// so effort is pinned too. Whether the harness honours a rewritten
// subagent_type in `updatedInput` is not documented. If it does not, the
// spawn runs as its ORIGINAL type, which SubagentStart then reports. So:
//
//   - a session is ARMED the first time the guard sees a ladder spawn or
//     makes a rewrite there (a rewrite needs a ladder start as evidence, and
//     that ladder agent was itself spawned through the guard). From then on
//     the guard records a pending entry for EVERY allowed spawn in that
//     session: the agent type it expects to start as (premiumAgentType
//     form), its type before any rewrite, and whether it was rewritten;
//   - SubagentStart (hooks/spawn-log.mjs) consumes the oldest pending entry
//     whose expected type matches the start, in spawn order, the way the
//     premium window matches its entries. (SubagentStart carries no
//     tool_use_id: its hook input is the session fields plus agent_id and
//     agent_type, checked in the 2.1.280 binary.) A start that matches
//     none, but does match a pending rewrite's ORIGINAL type, is that
//     rewritten spawn running as what it was before: the rewrite was
//     ignored. That is recorded for the session, and the guard stops
//     rewriting there and gives its advisory instead;
//   - that conclusion is drawn ONLY when the correlation is positive: the
//     session was armed at least PREMIUM_PENDING_MS before this start, so
//     every spawn that could still be starting was recorded, and the only
//     unmatched spawn of the start's type is the rewrite. Otherwise (armed
//     too recently: a plain spawn made before arming could be the one
//     starting) nothing is concluded, nothing is consumed, and no
//     rewrite_ignored is written;
//   - a REPEAT start (an agent_id that has already started in this session,
//     which is what continuing a worker with SendMessage fires: a second
//     SubagentStart with the same agent_id and no Agent PreToolUse) is no
//     spawn at all. It concludes nothing, consumes nothing and writes
//     nothing. Starts seen while the session is recorded are kept in
//     `started`; an agent that started before the session was recorded is
//     found in the start log (telemetry/subagent-starts.jsonl), read only
//     when this start could otherwise consume or conclude something.
// Entries expire after PREMIUM_PENDING_MS, the measured spawn-to-start lag
// with headroom.
//
// state/ladder-rewrites.json:
//   { "<session_id>": { armedAt, pending: [{ at, expect, from, rewrite, wanted }],
//                       ignored: { at, wanted, ranAs } | null, started: [agent_id], touched } }

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateFile, readJson, writeJsonAtomic, telemetryDir, isFixtureSession } from './context.mjs';
import { withStateLock, premiumAgentType, PREMIUM_PENDING_MS } from './premium-window.mjs';

export const REWRITE_FILE = 'ladder-rewrites.json';
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const STARTED_MAX = 500; // agent_ids kept per session; the start log covers the rest

// Has this agent_id already started in this session, per the start log?
// spawn-log.mjs resolves BEFORE it appends the current start, so any row
// found is an earlier start. A fixture session's rows go to fixtures.jsonl.
function startLogged(sid, agentId) {
  try {
    const name = isFixtureSession(sid) ? 'fixtures.jsonl' : 'subagent-starts.jsonl';
    const file = join(telemetryDir(), name);
    if (!existsSync(file)) return false;
    const needle = JSON.stringify(String(agentId));
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes(needle)) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.session_id === sid && r.agent_id === agentId
          && (name !== 'fixtures.jsonl' || r.stream === 'subagent-starts.jsonl')) return true;
      } catch { /* skip a torn line */ }
    }
  } catch { /* fail quiet: treated as not logged */ }
  return false;
}

function load(f, now) {
  const raw = readJson(f, {});
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [sid, s] of Object.entries(raw)) {
    if (!s || typeof s !== 'object' || typeof s.touched !== 'number' || now - s.touched > KEEP_MS) continue;
    const pending = (Array.isArray(s.pending) ? s.pending : [])
      .filter((e) => e && typeof e.at === 'number' && now - e.at < PREMIUM_PENDING_MS);
    out[sid] = {
      armedAt: typeof s.armedAt === 'number' ? s.armedAt : null,
      pending,
      ignored: s.ignored && typeof s.ignored === 'object' ? s.ignored : null,
      started: Array.isArray(s.started) ? s.started.filter((x) => typeof x === 'string').slice(-STARTED_MAX) : [],
      touched: s.touched,
    };
  }
  return out;
}

// Guard side, cheap and lock-free: the session's recorded state, or null.
export function rewriteState(sid, now = Date.now()) {
  try {
    const all = load(stateFile(REWRITE_FILE), now);
    return all[String(sid)] || null;
  } catch {
    return null;
  }
}

// Guard side: record one spawn. `type` is what it will start as, `from` its
// type before any rewrite, `rewrite` whether the guard rewrote it, `arm`
// whether this spawn arms the session (a ladder spawn; a rewrite always does).
export function notePendingSpawn(sid, { type, from, rewrite, arm }, now = Date.now()) {
  const f = stateFile(REWRITE_FILE);
  try {
    withStateLock(f, () => {
      const all = load(f, now);
      const key = String(sid);
      const s = all[key] || { armedAt: null, pending: [], ignored: null, started: [], touched: now };
      if ((arm || rewrite) && typeof s.armedAt !== 'number') s.armedAt = now;
      s.pending.push({
        at: now, expect: premiumAgentType(type), from: premiumAgentType(from), rewrite: !!rewrite,
        wanted: rewrite ? String(type) : null,
      });
      s.touched = now;
      all[key] = s;
      writeJsonAtomic(f, all);
    });
  } catch { /* fail open */ }
}

// SubagentStart side. Returns null (session not recorded, or no entry this
// start can be tied to), { repeat: true } (this agent_id already started in
// this session: a continued agent, not a spawn; nothing concluded, consumed or
// written), { matched: true }, { ambiguous: true } (it may be an ignored
// rewrite, or a spawn made before the session was armed: no conclusion,
// nothing consumed), or { ignored: { wanted, ranAs } } when this start is
// positively the rewritten spawn run as its original type.
export function resolveSpawnStart(sid, agentType, now = Date.now(), agentId = null) {
  if (!sid) return null;
  const f = stateFile(REWRITE_FILE);
  const aid = agentId ? String(agentId) : null;
  try {
    // Lock-free precheck: the file does not exist at all until the guard
    // first records a spawn, and only recorded sessions are tracked.
    const pre = readJson(f, null);
    const ps = pre && pre[String(sid)];
    if (!ps || typeof ps !== 'object') return null;
    if (aid && Array.isArray(ps.started) && ps.started.includes(aid)) return { repeat: true };
    const hasPending = Array.isArray(ps.pending) && ps.pending.length > 0;
    // Nothing to consume and no id to remember: nothing to do.
    if (!hasPending && !aid) return null;
    // Could consume or conclude: an agent that started before the session
    // was recorded is only in the start log.
    if (hasPending && aid && startLogged(String(sid), aid)) return { repeat: true };
    return withStateLock(f, () => {
      const all = load(f, now);
      const key = String(sid);
      const s = all[key];
      if (!s) return null;
      if (aid && s.started.includes(aid)) return { repeat: true };
      const remember = () => {
        if (!aid) return;
        s.started.push(aid);
        if (s.started.length > STARTED_MAX) s.started = s.started.slice(-STARTED_MAX);
      };
      if (!s.pending.length) {
        remember();
        s.touched = now;
        all[key] = s;
        writeJsonAtomic(f, all);
        return null;
      }
      const t = premiumAgentType(agentType);
      let result = null;
      let idx = s.pending.findIndex((e) => e.expect === t);
      if (idx >= 0) {
        result = { matched: true };
      } else {
        idx = s.pending.findIndex((e) => e.rewrite && e.from === t);
        const armedLongEnough = typeof s.armedAt === 'number' && now - s.armedAt >= PREMIUM_PENDING_MS;
        if (idx >= 0 && !armedLongEnough) {
          // Nothing concluded or consumed; the id is still remembered so a
          // later continuation of this agent is known as a repeat.
          if (aid) { remember(); s.touched = now; all[key] = s; writeJsonAtomic(f, all); }
          return { ambiguous: true };
        }
        if (idx >= 0) {
          const ranAs = String(agentType || 'general-purpose');
          result = { ignored: { wanted: s.pending[idx].wanted, ranAs } };
          s.ignored = { at: now, wanted: s.pending[idx].wanted, ranAs };
        }
      }
      if (idx < 0) {
        if (aid) { remember(); s.touched = now; all[key] = s; writeJsonAtomic(f, all); }
        return null;
      }
      s.pending.splice(idx, 1);
      remember();
      s.touched = now;
      all[key] = s;
      writeJsonAtomic(f, all);
      return result;
    });
  } catch {
    return null;
  }
}
