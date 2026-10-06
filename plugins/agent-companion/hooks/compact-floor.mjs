// Main-session compaction floor: a hooks MODULE (function hook), not a command
// hook. Loaded through the "modules" key of hooks/hooks.json, it runs inside
// Claude Code's own module sandbox (no Node, no process.env), so everything it
// touches comes through `$`.
//
// What it does. Claude Code has ONE auto-compact window for the main session
// and every subagent (CLAUDE_CODE_AUTO_COMPACT_WINDOW / autoCompactWindow).
// This hook lets the MAIN session compact later than that window: it vetoes
// `session.compact` for trigger "auto" AND "precompute" on the main session
// until the context reaches `main_compact_floor_tokens` (clamped, see below).
// Subagents (e.agentId set), manual compaction and the plugin trigger always
// pass straight through to core.
//
// Why precompute too (measured in the 2.1.286 binary): core arms a precomputed
// summary early (a fraction of the window, ~184K at a 250K window), keeps it,
// and at the threshold APPLIES it as summary-of-the-first-184K plus every raw
// message since. Held back to a 367K floor that is a compaction that frees
// about half of what a fresh summary would, and a summary call paid for in
// vain. A vetoed precompute computes and keeps nothing and counts no failure
// (core records a veto, not a counted failure), so main just compacts
// synchronously, with a fresh summary, at the floor.
//
// Wedge guard. The engine blocks the prompt hard at about window - 23K
// ("Prompt is too long"), and a vetoed auto-compaction never lifts that. So the
// floor actually enforced is min(floor, window - WINDOW_MARGIN), where window is
// $.session.usage().context.window (the model's window). On a 200K model the
// enforced floor is 50K, which any auto-compaction already exceeds, so the hook
// never vetoes there. An unknown window passes (fail open, logged once).
//
// OFF by default: option unset or 0 means every call is `next(e)`. Fails open
// on a bad option value and on any exception: a broken veto must never block
// compaction, because a main session that cannot compact stalls at the limit.
//
// The pure decision lives in decideCompact() so a unit test can pin it without
// the engine. register() is the thin wrapper that reads the option, asks the
// engine for the token count, and writes one bounded log line per decision
// worth recording (see below).

export const MIN_FLOOR = 100000;
// A typo guard only: the real ceiling is the window clamp below (850K on a 1M
// model), so a floor between 850K and MAX_FLOOR is accepted and clamped.
export const MAX_FLOOR = 1000000;
// Headroom kept under the model window. The hard block sits at window - 23K, one
// turn can add 50-100K, and the compaction call itself needs room to run.
export const WINDOW_MARGIN = 150000;
export const LOG_MAX_LINES = 200;
export const LOG_FILE = 'compact-floor.log';

// The engine suppresses the "compaction skipped" toast only for a reason that
// starts with exactly this prefix (measured on 2.1.286); keep it first.
export const SKIP_REASON_PREFIX = 'Compaction blocked by PreCompact hook';
export const SKIP_REASON = `${SKIP_REASON_PREFIX}: main session below compact floor (agent-companion main_compact_floor_tokens)`;

// Normalise the option to { off } | { floor } | { bad }. Unset, 0, '' and
// false are OFF; a number or numeric string inside [MIN_FLOOR, MAX_FLOOR] is
// the floor; anything else (negative, tiny, huge, NaN, non-numeric, a list) is
// BAD and fails open with a one-time log line.
export function parseFloor(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === false) return { off: true };
  if (typeof raw === 'boolean' || Array.isArray(raw)) return { bad: String(raw) };
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { bad: String(raw) };
  if (n === 0) return { off: true };
  if (n < MIN_FLOOR || n > MAX_FLOOR) return { bad: String(raw) };
  return { floor: Math.floor(n) };
}

// The whole decision. `parsed` is parseFloor()'s result; returns
// { action: 'skip' | 'pass', why, floor?, clamped? } where `floor` is the floor
// actually enforced, min(floor, window - WINDOW_MARGIN). Only a MAIN-session
// AUTO or PRECOMPUTE compaction below that floor, with a known window and token
// count, is skipped. A clamped floor at or below the compact threshold never
// vetoes: auto-compaction fires at or above the threshold, so tokens >= floor.
export function decideCompact({ parsed, trigger, agentId, tokens, window }) {
  if (!parsed || parsed.off) return { action: 'pass', why: 'off' };
  if (parsed.bad !== undefined) return { action: 'pass', why: 'bad-option' };
  if (trigger !== 'auto' && trigger !== 'precompute') return { action: 'pass', why: 'trigger' };
  if (agentId) return { action: 'pass', why: 'subagent' };
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return { action: 'pass', why: 'no-window' };
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return { action: 'pass', why: 'no-tokens' };
  const cap = window - WINDOW_MARGIN;
  const clamped = parsed.floor > cap;
  const floor = clamped ? cap : parsed.floor;
  if (tokens >= floor) return { action: 'pass', why: 'at-floor', floor, clamped };
  return { action: 'skip', why: 'below-floor', floor, clamped };
}

// Keep the last LOG_MAX_LINES lines of `prev` plus `line`.
export function appendBounded(prev, line, max = LOG_MAX_LINES) {
  const lines = (prev || '').split('\n').filter(Boolean);
  lines.push(line);
  return lines.slice(-max).join('\n') + '\n';
}

// Both helpers are top-level function declarations because the engine scans
// the module's source and only follows `$` into functions declared at the top.
// Per-session state lives in the `state` object register() makes (module
// variables live for the session and restart on a reload).
function logLine($, state, text) {
  state.writing = state.writing
    .then(async () => {
      // The plugin's state-dir env var (the one the command hooks honour),
      // else the plugin data dir when the engine exposes it to modules (2.1.286
      // does not), else the plugin's state root under the Claude config dir.
      // Env names must be string literals ($.env.get is statically scanned).
      let dir = (await $.env.get('AGENT_COMPANION_STATE_DIR')) || (await $.env.get('CLAUDE_PLUGIN_DATA'));
      if (!dir) {
        const cfg = await $.env.get('CLAUDE_CONFIG_DIR');
        const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'));
        dir = cfg ? `${cfg}/agent-companion` : home ? `${home}/.claude/agent-companion` : undefined;
      }
      if (!dir) return;
      const path = `${dir.replace(/[\\/]+$/, '')}/${LOG_FILE}`;
      const prev = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
      const ts = new Date(await $.clock.now()).toISOString();
      await $.fs.write(path, appendBounded(prev, `${ts} ${text}`));
    })
    .catch(() => {});
  return state.writing;
}

// true = veto this compaction. Decided inside try/catch; the caller invokes
// next() outside it, so a throw from core's own compaction cannot make this
// hook run next() a second time. Logging stays bounded: ONE line at the first
// veto of the session, ONE per main-session pass, ONE per fail-open kind.
async function verdict($, e, state, options) {
  try {
    const parsed = parseFloor(options?.main_compact_floor_tokens);
    // Cheap exits first: the option off, a subagent or a non-auto trigger
    // never reads usage and never touches the log.
    if (parsed.off) return false;
    if (parsed.bad !== undefined) {
      if (!state.failOpenLogged.has('bad-option')) {
        state.failOpenLogged.add('bad-option');
        await logLine($, state, `fail-open: main_compact_floor_tokens=${JSON.stringify(parsed.bad)} outside ${MIN_FLOOR}-${MAX_FLOOR}; compaction not vetoed`);
      }
      return false;
    }
    if ((e.trigger !== 'auto' && e.trigger !== 'precompute') || e.agentId) return false;
    const usage = await $.session.usage();
    const tokens = usage?.context?.tokens;
    const window = usage?.context?.window;
    const d = decideCompact({ parsed, trigger: e.trigger, agentId: e.agentId, tokens, window });
    if (d.clamped && !state.failOpenLogged.has('clamp')) {
      state.failOpenLogged.add('clamp');
      await logLine($, state, `clamp: floor ${parsed.floor} is within ${WINDOW_MARGIN} of the model window ${window}; enforcing ${d.floor} instead (a veto past the window would wedge the session)`);
    }
    if (d.action === 'skip') {
      // A skipped precompute computes and keeps nothing and costs core no
      // failure; it stays out of the log and the counters (it repeats per turn).
      if (e.trigger === 'precompute') return true;
      if (!state.vetoLogged) {
        state.vetoLogged = true;
        await logLine($, state, `veto: main auto-compaction held at tokens=${tokens} window=${window} floor=${d.floor} (first of this session; later vetoes are counted on the next pass line)`);
      } else {
        state.vetoesSinceLog += 1;
      }
      return true;
    }
    if (d.why === 'at-floor' && e.trigger === 'auto') {
      await logLine($, state, `pass: main auto-compaction allowed at tokens=${tokens} window=${window} floor=${d.floor} vetoes_since_last_line=${state.vetoesSinceLog}`);
      state.vetoesSinceLog = 0;
    } else if (d.why === 'no-tokens' && !state.failOpenLogged.has('no-tokens')) {
      state.failOpenLogged.add('no-tokens');
      await logLine($, state, 'fail-open: session usage had no context token count; compaction not vetoed');
    } else if (d.why === 'no-window' && !state.failOpenLogged.has('no-window')) {
      state.failOpenLogged.add('no-window');
      await logLine($, state, 'fail-open: session usage had no context window size; compaction not vetoed');
    }
    return false;
  } catch {
    // Fail open: any error here lets core compact as it would have.
    try {
      if (!state.failOpenLogged.has('error')) {
        state.failOpenLogged.add('error');
        await logLine($, state, 'fail-open: exception in the compact-floor hook; compaction not vetoed');
      }
    } catch {}
    return false;
  }
}

export const register = (on, options) => {
  const state = { vetoLogged: false, vetoesSinceLog: 0, failOpenLogged: new Set(), writing: Promise.resolve() };
  on('session.compact', async ($, e, next) => ((await verdict($, e, state, options)) ? { skip: SKIP_REASON } : next(e)));
};
