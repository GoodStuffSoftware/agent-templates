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
// A refusal writes one row to telemetry/question-dialog.jsonl (the rule that fired). Its own stream, not denials.jsonl: a
// row there would hide a silent spawn guard from the scout's zero-denials canary (scripts/detect.mjs).
// Never an "allow" decision: with nothing to refuse the hook prints nothing.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readStdin, opt, passthrough, deny, isMainThread, claudeDir, appendLog,
} from './lib/context.mjs';

const QUESTION_DIALOG_DENY = 'Do not open a question dialog. It holds this session\'s turn open until the operator answers, '
  + 'and every message from other agents and every worker result waits behind it, sometimes for hours. Carry on with everything '
  + 'that does not depend on the answer. Then put the question, the options and your recommendation in the closing message of '
  + 'this turn (or in the app\'s end-of-turn question tool, if there is one) and end the turn.';

const LIVE_WINDOW_MS = 2 * 3600 * 1000;

// Other sessions active in the last two hours, from Claude Code's session records (one small JSON file per live
// process: <claude dir>/sessions/<pid>.json with sessionId, status and updatedAt/statusUpdatedAt/startedAt in ms). The
// times move on a status change only, so a session that has been busy for hours is counted while its process is alive.
// Returns the count, or null when the folder cannot be read (the caller then uses the repo-scoped fallback).
function processAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}
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
      if ((t > 0 && now - t <= LIVE_WINDOW_MS) || (r.status === 'busy' && Number(r.pid) > 0 && processAlive(r.pid))) n += 1;
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
      appendLog('question-dialog.jsonl', {
        at: new Date().toISOString(), session_id: String(p.session_id), rule: d.rule, n: d.n,
        mode: d.rule === 'end-turn' ? 'end-turn' : 'auto', permission_mode: p.permission_mode ?? null,
      });
      deny(QUESTION_DIALOG_DENY);
    }
  }
} catch {
  // fail open
}
passthrough();
