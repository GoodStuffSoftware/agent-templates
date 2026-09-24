// The premium fan-out window (state/premium-window.json), shared by the two
// hooks that write it: the spawn guard (PreToolUse) and spawn-log
// (SubagentStart). Kept out of context.mjs so the lock helper it needs is
// loaded only by those two hooks, not by every hook and CLI that imports
// context.mjs for routing (S2 review P9: the hook-path budget).

import { withFileLock } from './file-lock.mjs';
import { stateFile, readJson, writeJsonAtomic } from './context.mjs';

// An exclusive lock for a read-modify-write of one small state file, shared
// by every hook process that writes it (the premium window: the spawn guard
// on PreToolUse and spawn-log on SubagentStart). The lock is `<file>.lock`,
// managed by the shared helper (lib/file-lock.mjs): a unique owner token,
// released only by its owner, and broken only when its owner's pid is dead
// AND it is older than STATE_LOCK_STALE_MS, by an atomic rename that is
// re-verified. A waiter polls for at most STATE_LOCK_WAIT_MS; on timeout, or
// when the lock cannot be created at all, fn still runs, unlocked: a hook
// fails open and never throws for a lock. fn must not exit the process
// (deny() does): return a verdict and act on it after the lock is released.
export const STATE_LOCK_WAIT_MS = 2000;
export const STATE_LOCK_STALE_MS = 5000;
export function withStateLock(file, fn) {
  return withFileLock(`${file}.lock`, () => fn(), {
    waitMs: STATE_LOCK_WAIT_MS, staleMs: STATE_LOCK_STALE_MS, failOpen: true,
  });
}

// --- Premium fan-out window (state/premium-window.json) ---------------------
// The cap counts premium spawns that actually STARTED, not every spawn the
// guard allowed. An allowed spawn the harness then rejects (an unknown
// subagent_type, say) used to hold a slot for the whole window, so each
// failed retry extended the block. Now the guard records a PENDING entry
// {t, sid, confirmed:false}; the SubagentStart hook (spawn-log.mjs) confirms
// the oldest pending entry for its session; an entry never confirmed stops
// counting after PREMIUM_PENDING_MS. Pending entries DO count while young,
// so a parallel burst (several spawns before any has started — the
// four-Fable shape) is still capped. PREMIUM_PENDING_MS is set from measured
// spawn-to-start lag (p50 ~0.1 s, p99 ~52 s, max ~101 s over 394 pairs,
// 2026-09-24) with headroom. A bare number is a pre-1b entry: confirmed.
export const PREMIUM_WINDOW_MS = 10 * 60 * 1000;
export const PREMIUM_PENDING_MS = 3 * 60 * 1000;

function windowEntryLive(e, now) {
  if (typeof e === 'number') return now - e < PREMIUM_WINDOW_MS;
  if (!e || typeof e.t !== 'number') return false;
  return now - e.t < (e.confirmed ? PREMIUM_WINDOW_MS : PREMIUM_PENDING_MS);
}

export function premiumWindowLive(entries, now = Date.now()) {
  return (Array.isArray(entries) ? entries : []).filter((e) => windowEntryLive(e, now));
}

// The agent type as both hooks see it, for matching a start to its spawn:
// the part after any plugin namespace ("agent-companion:ac-opus" and
// "ac-opus" are one type), lower-cased; a spawn naming none runs as
// general-purpose, which is what SubagentStart then reports.
export function premiumAgentType(t) {
  return String(t || 'general-purpose').split(':').pop().trim().toLowerCase() || 'general-purpose';
}

// SubagentStart: confirm the oldest live pending entry for this session
// whose agent type matches the start's (RC review R7). SubagentStart
// carries agent_type (not the model), and the spawn guard records the
// spawn's type on its entry (`atype`), so a NON-premium start in the same
// session no longer confirms a premium spawn's entry. Matched by session
// only when either side lacks a type (an entry from an older guard, or a
// payload with no agent_type): that over-counts, the safe direction.
// Returns true when one was confirmed.
export function confirmPremiumStart(sessionId, now = Date.now(), agentType = null) {
  if (!sessionId) return false;
  const want = agentType ? premiumAgentType(agentType) : null;
  const f = stateFile('premium-window.json');
  // Under the window lock (withStateLock): the spawn guard read-modify-writes
  // the same file, and an unlocked interleaving lost one side's update.
  return withStateLock(f, () => {
    const live = premiumWindowLive(readJson(f, []), now);
    const idx = live.findIndex((e) => e && typeof e === 'object' && !e.confirmed && e.sid === sessionId
      && (!want || typeof e.atype !== 'string' || e.atype === want));
    if (idx < 0) return false;
    live[idx] = { ...live[idx], confirmed: true, startedAt: now };
    writeJsonAtomic(f, live);
    return true;
  });
}
