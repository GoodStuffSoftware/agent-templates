// Main-session compaction floor: a hooks MODULE (function hook), not a command
// hook. Loaded through the "modules" key of hooks/hooks.json, it runs inside
// Claude Code's own module sandbox (no Node, no process.env), so everything it
// touches comes through `$`.
//
// What it does. Claude Code has ONE auto-compact window for the main session
// and every subagent (CLAUDE_CODE_AUTO_COMPACT_WINDOW / autoCompactWindow).
// This hook lets the MAIN session compact later than that window: it vetoes
// `session.compact` for trigger "auto" on the main session until the context
// reaches `main_compact_floor_tokens`. Subagents (e.agentId set), manual
// compaction and every other trigger always pass straight through to core.
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
export const MAX_FLOOR = 1000000;
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
// { action: 'skip' | 'pass', why }. Only a MAIN-session AUTO compaction below
// a valid floor, with a known token count, is skipped.
export function decideCompact({ parsed, trigger, agentId, tokens }) {
  if (!parsed || parsed.off) return { action: 'pass', why: 'off' };
  if (parsed.bad !== undefined) return { action: 'pass', why: 'bad-option' };
  if (trigger !== 'auto') return { action: 'pass', why: 'trigger' };
  if (agentId) return { action: 'pass', why: 'subagent' };
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return { action: 'pass', why: 'no-tokens' };
  if (tokens >= parsed.floor) return { action: 'pass', why: 'at-floor' };
  return { action: 'skip', why: 'below-floor' };
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
      const path = `${dir.replace(/[\/]+$/, '')}/${LOG_FILE}`;
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
    if (e.trigger !== 'auto' || e.agentId) return false;
    const usage = await $.session.usage();
    const tokens = usage?.context?.tokens;
    const d = decideCompact({ parsed, trigger: e.trigger, agentId: e.agentId, tokens });
    if (d.action === 'skip') {
      if (!state.vetoLogged) {
        state.vetoLogged = true;
        await logLine($, state, `veto: main auto-compaction held at tokens=${tokens} floor=${parsed.floor} (first of this session; later vetoes are counted on the next pass line)`);
      } else {
        state.vetoesSinceLog += 1;
      }
      return true;
    }
    if (d.why === 'at-floor') {
      await logLine($, state, `pass: main auto-compaction allowed at tokens=${tokens} floor=${parsed.floor} vetoes_since_last_line=${state.vetoesSinceLog}`);
      state.vetoesSinceLog = 0;
    } else if (d.why === 'no-tokens' && !state.failOpenLogged.has('no-tokens')) {
      state.failOpenLogged.add('no-tokens');
      await logLine($, state, 'fail-open: session usage had no context token count; compaction not vetoed');
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
