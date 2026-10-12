// Catch-up note. SessionStart (--event snapshot) records what the session has
// loaded; UserPromptSubmit (--event diff) adds ONE short note listing what
// arrived since, once per item. Lead only. Silent when nothing changed.
// Kill switch: plugin option `catchup_note` (default true). Fail-open.
import { readStdin, opt, passthrough, callerIsSubagent, sessionIsSubagent } from './lib/context.mjs';
import { takeSnapshot, readState, writeState, diffSession } from './lib/session-delta.mjs';

try {
  if (!opt('catchup_note', true)) passthrough();
  const p = readStdin();
  const sid = p && p.session_id;
  if (typeof sid !== 'string' || !sid) passthrough();
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--event');
  const event = i >= 0 ? argv[i + 1] : '';

  if (event === 'snapshot') {
    if (sessionIsSubagent(p)) passthrough();
    const src = p.source || 'startup';
    const prior = readState(sid);
    if (src === 'compact' && prior) {
      // CLAUDE.md is reloaded after a compaction: refresh only that part.
      const fresh = takeSnapshot(p);
      for (const k of Object.keys(fresh.files)) if (k.startsWith('claude:')) prior.files[k] = fresh.files[k];
      writeState(sid, prior);
    } else if (src !== 'resume' && src !== 'compact') {
      writeState(sid, takeSnapshot(p));
    }
    // resume: keep the old snapshot; with none (started before this hook), the
    // first prompt falls back to t0 from the transcript.
  } else if (event === 'diff') {
    if (callerIsSubagent(p)) passthrough();
    const prompt = String(p.prompt ?? p.user_input ?? '');
    if (prompt.startsWith('<task-notification')) passthrough();
    const { note, state } = diffSession(p, readState(sid));
    if (state) writeState(sid, state);
    if (note) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note },
      }));
    }
  }
} catch {
  // fail open
}
passthrough();
