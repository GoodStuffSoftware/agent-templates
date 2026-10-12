// Advisory notes for a lead session: live sessions (F9), peer-message warning
// (F10), overdue worker (F14). Logic in lib/advisory-b.mjs. Never blocks, adds
// no tokens unless a note fires, starts no child process, fails open.
//   --event session-start   F9 (SessionStart)
//   --event user-prompt     F9 when the set changed, F14 (UserPromptSubmit)
//   --event tick            F14 (PostToolUse, any tool)
//   --event send            F10 (PreToolUse SendMessage)
//   --event worker-start | worker-stop   ledger (SubagentStart / SubagentStop)

import { readStdin, opt, passthrough, callerIsSubagent, sessionIsSubagent } from './lib/context.mjs';
import {
  ledgerWrite, overdueNotices, peerMessageNote, parseKnownPeers, liveSessionsNote, parseRelated, OVERDUE_DEFAULT_MINUTES,
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
    if (wantF14 || wantF10) ledgerWrite(p.session_id, EVENT === 'worker-start' ? 'start' : 'stop', p);
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
    const parts = [];
    if (EVENT !== 'tick' && wantF9 && !sessionIsSubagent(p)) {
      try {
        const n = liveSessionsNote(p, { related: parseRelated(opt('related_repos', '')), mode: EVENT === 'session-start' ? 'start' : 'change' });
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
