// Advisory notes for a lead session: live sessions (F9), peer-message warning
// (F10), overdue worker (F14), shared resources line (resource queue), keep-warm (lib/keep-warm.mjs). Logic in lib/advisory-b.mjs. Never blocks, adds
// no tokens unless a note fires, starts no child process, fails open.
//   --event session-start   F9 (SessionStart)
//   --event user-prompt     F9 when the set changed, F14 (UserPromptSubmit)
//   --event tick            F14 (PostToolUse, any tool)
//   --event send            F10 (PreToolUse SendMessage)
//   --event worker-start | worker-stop   ledger (SubagentStart / SubagentStop)
//   --event task-stop       ledger stop row (PostToolUse TaskStop)

import { readStdin, opt, passthrough, callerIsSubagent, sessionIsSubagent } from './lib/context.mjs';
import { sharedResourcesNote, ensureLauncher } from './lib/resource-line.mjs';
import { keepWarmToolNote, keepWarmPingNote, KEEP_WARM_MAX_DEFAULT_MIN } from './lib/keep-warm.mjs';
import {
  ledgerWrite, workerStatus, taskStopWrite, pruneState, overdueNotices, peerMessageNote, parseKnownPeers, liveSessionsNote, parseRelated, OVERDUE_DEFAULT_MINUTES,
} from './lib/advisory-b.mjs';

const i = process.argv.indexOf('--event');
const EVENT = i >= 0 ? process.argv[i + 1] : '';

function emit(hookEventName, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }));
  process.exit(0);
}

try {
  const p = readStdin();
  const wantF14 = opt('overdue_worker_warning', true) && opt('overdue_worker_minutes', OVERDUE_DEFAULT_MINUTES) > 0;
  const wantF10 = opt('peer_message_warning', true);
  const wantF9 = opt('live_sessions', true);

  if (EVENT === 'worker-start' || EVENT === 'worker-stop') {
    if (wantF14 || wantF10) {
      if (EVENT === 'worker-start') ledgerWrite(p.session_id, 'start', p);
      else ledgerWrite(p.session_id, 'stop', p, Date.now(), { status: workerStatus(p) });
    }
    passthrough();
  }
  if (EVENT === 'task-stop') {
    if (wantF14 || wantF10) taskStopWrite(p);
    passthrough();
  }
  if (callerIsSubagent(p)) passthrough();

  if (EVENT === 'send') {
    if (!wantF10) passthrough();
    const note = peerMessageNote(p, { knownPeers: parseKnownPeers(opt('known_peers', '')) });
    if (note) emit('PreToolUse', note);
    passthrough();
  }
  if (EVENT === 'tick' || EVENT === 'user-prompt' || EVENT === 'session-start') {
    if (EVENT === 'session-start') pruneState();
    const parts = [];
    // Keep-warm: while background helpers run, the lead is told to arm one wakeup inside its cache window
    // (after a background spawn) and, at each ping, whether to re-arm. Lead only; one small state file.
    if (opt('keep_warm', true) && !sessionIsSubagent(p)) {
      try {
        const maxMinutes = opt('keep_warm_max_minutes', KEEP_WARM_MAX_DEFAULT_MIN);
        const n = EVENT === 'tick' ? keepWarmToolNote(p, { maxMinutes }) : EVENT === 'user-prompt' ? keepWarmPingNote(p, { maxMinutes }) : null;
        if (n) parts.push(n);
      } catch { /* advisory */ }
    }
    if (EVENT !== 'tick' && wantF9 && !sessionIsSubagent(p)) {
      try {
        const n = liveSessionsNote(p, { related: parseRelated(opt('related_repos', '')), mode: EVENT === 'session-start' ? 'start' : 'change' });
        if (n) parts.push(n);
      } catch { /* advisory */ }
    }
    // The machine-wide resource queue, next to the other-sessions line: shown only
    // while something is held, queued, reserved or was just cleared. SessionStart
    // also makes sure the stable launcher path exists (idempotent).
    if (EVENT !== 'tick' && opt('shared_resources_line', true) && !sessionIsSubagent(p)) {
      try {
        if (EVENT === 'session-start') await ensureLauncher();
        const n = await sharedResourcesNote(p, { mode: EVENT === 'session-start' ? 'start' : 'change' });
        if (n) parts.push(n);
      } catch { /* advisory */ }
    }
    if (EVENT !== 'session-start' && wantF14) {
      try { parts.push(...overdueNotices(p, { minutes: opt('overdue_worker_minutes', OVERDUE_DEFAULT_MINUTES) })); } catch { /* advisory */ }
    }
    if (parts.length) emit({ 'session-start': 'SessionStart', 'user-prompt': 'UserPromptSubmit', tick: 'PostToolUse' }[EVENT], parts.join('\n'));
  }
} catch { /* fail open */ }
passthrough();
