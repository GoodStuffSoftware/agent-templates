// PreToolUse on AskUserQuestion, main thread only (0.31.51). A question dialog holds the session's turn open until the
// operator answers, and everything sent to the session waits behind it: messages from other agents, worker results.
// A question asked in the closing message of a turn blocks nothing. So when a dialog would block someone, this hook
// refuses it with a reason that says what to do instead (QUESTION_DIALOG_DENY, the same text every time, no escalation).
//
// Option `question_dialog` (allow | end-turn | auto, default auto):
//   allow     never interferes.
//   end-turn  always turns the dialog away.
//   auto      turns it away only when someone could be waiting, checked cheapest first:
//               helpers        this session has background helpers running (the worker ledger, hooks/lib/advisory-b.mjs)
//               live-sessions  another session was active on this machine in the last two hours (Claude Code's own
//                              session records in <claude dir>/sessions; where that folder is absent, the repo-scoped
//                              liveSessions() of advisory-b.mjs)
//               peer-message   this session has received a message from another session (a tail read of its transcript,
//                              receivedPeers() of advisory-b.mjs)
//             With none of them the dialog is allowed.
// A session in plan mode (permission_mode "plan") is always allowed: the operator is at the keyboard planning.
// Fail-open: any error, missing state or unreadable input lets the dialog through; the hook never blocks another tool.
// A refusal writes one denials.jsonl row (guard "question-dialog", detail names the rule that fired).
// Never an "allow" decision: with nothing to refuse the hook prints nothing.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readStdin, opt, passthrough, deny, isMainThread, claudeDir, recordDenial,
} from './lib/context.mjs';

const QUESTION_DIALOG_DENY = 'Do not open a question dialog. It holds this session\'s turn open until the operator answers, '
  + 'and every message from other agents and every worker result waits behind it, sometimes for hours. Carry on with everything '
  + 'that does not depend on the answer. Then put the question, the options and your recommendation in the closing message of '
  + 'this turn (or in the app\'s end-of-turn question tool, if there is one) and end the turn.';

const LIVE_WINDOW_MS = 2 * 3600 * 1000;

// Other sessions active in the last two hours, from Claude Code's session records (one small JSON file per live
// process: <claude dir>/sessions/<pid>.json with sessionId and updatedAt/statusUpdatedAt/startedAt in ms). Returns the
// count, or null when the folder cannot be read (the caller then uses the repo-scoped fallback).
function registryLiveCount(sessionId, now) {
  const dir = join(claudeDir(), 'sessions');
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  let n = 0;
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!r || typeof r !== 'object' || (r.sessionId && r.sessionId === sessionId)) continue;
      const t = Math.max(...['updatedAt', 'statusUpdatedAt', 'startedAt'].map((k) => (Number.isFinite(Number(r[k])) ? Number(r[k]) : 0)));
      if (t > 0 && now - t <= LIVE_WINDOW_MS) n += 1;
    } catch { /* one unreadable record is skipped */ }
  }
  return n;
}

async function decide(p) {
  const mode = String(opt('question_dialog', 'auto')).trim().toLowerCase();
  if (mode === 'allow') return null;
  if (mode === 'end-turn') return { rule: 'end-turn', n: 0 };
  // auto (and any value that is not one of the three)
  const adv = await import('./lib/advisory-b.mjs');
  const now = Date.now();
  const helpers = [...adv.readWorkers(p.session_id, { transcriptPath: p.transcript_path, now }).values()].filter((w) => w.running).length;
  if (helpers > 0) return { rule: 'helpers', n: helpers };
  let live = registryLiveCount(p.session_id, now);
  if (live === null) {
    live = adv.liveSessions({ sessionId: p.session_id, cwd: p.cwd || process.cwd(), related: adv.parseRelated(opt('related_repos', '')), now }).length;
  }
  if (live > 0) return { rule: 'live-sessions', n: live };
  if (p.transcript_path) {
    const peers = adv.receivedPeers(p.transcript_path).size;
    if (peers > 0) return { rule: 'peer-message', n: peers };
  }
  return null;
}

try {
  const p = readStdin();
  if (p.tool_name === 'AskUserQuestion' && isMainThread(p) && p.permission_mode !== 'plan') {
    const d = await decide(p);
    if (d) {
      try { recordDenial('question-dialog', p, `rule=${d.rule}${d.n ? ` n=${d.n}` : ''}`); } catch { /* telemetry never blocks */ }
      deny(QUESTION_DIALOG_DENY);
    }
  }
} catch {
  // fail open
}
passthrough();
