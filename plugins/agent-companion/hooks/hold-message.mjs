// PostToolUse (Bash) and Stop: the local message each held lead is owed when the release hold clears.
//
// A held lead that stopped never sees another prompt, so the lead that runs `release-watch.mjs clear` must message each held session
// (a desktop session message, local_<uuid>). release-watch.mjs prints the ids ("Send each of these sessions a local message now: ...").
//   --event pre   PreToolUse (Bash, PowerShell): with a hold in scope "releases", refuses plugin install/update, marketplace update and release/* pushes or merges.
//   --event post  after a Bash call that ran `release-watch.mjs clear`: adds that instruction to the lead's context and records the ids
//                 with the transcript size at that moment (lib/release-watch-state.mjs notePendingMessages).
//   --event stop  the lead's end of turn: when its transcript since the clear has no message to some listed id (SendMessage with `to`, or
//                 mcp__ccd_session_mgmt__send_message with `session_id`), blocks ONCE with the missing ids. Never a second block.
// Fails open on every path.

import { openSync, readSync, closeSync, fstatSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 0.31.77: the pre event runs on every Bash and PowerShell call. With no hold file it exits here, having loaded only node built-ins:
// lib/context.mjs and lib/release-watch-state.mjs (and what they import) are loaded by dynamic import, after this check. The path is
// the one lib/context.mjs stateRootPath() + stateDir() resolve (tests/release-hold.test.mjs pins that they agree).
const holdFilePath = () => join(process.env.AGENT_COMPANION_STATE_DIR || join(process.env.CLAUDE_CONFIG_DIR || join(process.env.AGENT_COMPANION_HOME_OVERRIDE || homedir(), '.claude'), 'agent-companion'), 'state', 'release-hold.json');
if (process.argv[process.argv.indexOf('--event') + 1] === 'pre') {
  let none = false;
  try { none = !existsSync(holdFilePath()); } catch { none = false; }
  if (none) { try { readFileSync(0); } catch { /* no stdin */ } process.exit(0); }
}
const { readStdin, passthrough, deny, recordDenial } = await import('./lib/context.mjs');
const { MESSAGE_LINE, releaseActionDeny, withoutSelf, clearInstruction, notePendingMessages, readPendingMessages, settlePendingMessages, takeOwedMessages, INSTALL_CMD_RE, noteInstaller } = await import('./lib/release-watch-state.mjs');

export const CLEAR_CMD_RE = /release-watch\.mjs["']?\s+clear(?:\s|$)/;
const ID_RE = /^local_[A-Za-z0-9-]+$/;

// The ids from a clear's output: the "Send each ..." line, else the localSessionId of each lead in the --json form.
export function idsFromOutput(out) {
  const text = typeof out === 'string' ? out : out && typeof out === 'object' ? String(out.stdout ?? out.output ?? '') : '';
  const i = text.indexOf(MESSAGE_LINE);
  if (i >= 0) return text.slice(i + MESSAGE_LINE.length).split(/\r?\n/)[0].trim().split(/\s+/).filter((x) => ID_RE.test(x));
  try {
    const j = JSON.parse(text);
    return (j.heldSessions || []).filter((x) => !x.agentId && x.localSessionId).map((x) => x.localSessionId);
  } catch { return []; }
}

// Ids messaged in the transcript from byte `offset` on.
export function messagedSince(path, offset, ids) {
  const sent = new Set();
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const from = Math.min(Math.max(offset || 0, 0), size);
    const buf = Buffer.alloc(size - from);
    if (buf.length) readSync(fd, buf, 0, buf.length, from);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('tool_use')) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const c = r && r.message && r.message.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (!b || b.type !== 'tool_use' || !b.input) continue;
        if (b.name === 'SendMessage' && ids.includes(b.input.to)) sent.add(b.input.to);
        else if (/(?:^|__)ccd_session_mgmt__send_message$/.test(String(b.name)) && ids.includes(b.input.session_id)) sent.add(b.input.session_id);
      }
    }
  } catch { /* fail open: counts what it read */ } finally { try { if (fd !== undefined) closeSync(fd); } catch { /* ignore */ } }
  return sent;
}

try {
  const p = readStdin();
  const event = process.argv[process.argv.indexOf('--event') + 1];
  if (event === 'pre') {
    // PreToolUse (Bash, PowerShell): while a hold in scope "releases" is on, refuse agent-companion release and install commands (0.31.75).
    if (p.tool_name !== 'Bash' && p.tool_name !== 'PowerShell') passthrough();
    const cmd = String((p.tool_input && p.tool_input.command) || '');
    const text = releaseActionDeny(cmd);
    if (!text) passthrough();
    try { recordDenial('release-hold', p, 'release or install command refused by the hold'); } catch { /* telemetry */ }
    deny(text);
  }
  if (event === 'post') {
    if (!p.session_id || p.tool_name !== 'Bash') passthrough();
    const cmd = String((p.tool_input && p.tool_input.command) || '');
    // The release owner sees the watch notice first. Only a lead's own install is noted (a worker's transcript path is not the lead's).
    if (INSTALL_CMD_RE.test(cmd) && !p.agent_id) noteInstaller(p.session_id, p.transcript_path);
    if (p.agent_id || !CLEAR_CMD_RE.test(cmd)) passthrough();
    const ids = withoutSelf(idsFromOutput(p.tool_response), p.session_id);
    takeOwedMessages(p.session_id); // this lead was told by the clear's output: no other lead is told again
    if (!ids.length) passthrough();
    notePendingMessages(p.session_id, p.transcript_path, ids);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: clearInstruction(ids) } }));
    process.exit(0);
  } else if (event === 'stop') {
    if (p.agent_id || !p.session_id) passthrough();
    const pend = readPendingMessages(p.session_id);
    if (!pend || !Array.isArray(pend.ids)) passthrough();
    const sent = messagedSince(p.transcript_path, pend.offset, pend.ids);
    const missing = pend.ids.filter((x) => !sent.has(x));
    if (!missing.length) { settlePendingMessages(p.session_id, null); passthrough(); }
    if (pend.blocked) passthrough();
    if (!settlePendingMessages(p.session_id, { blocked: true })) passthrough(); // not recorded: never risk a second block
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `[agent-companion] The hold was cleared but these held sessions have not been messaged yet: ${missing.join(' ')}. Send each one SendMessage {to: "<id>"} or mcp__ccd_session_mgmt__send_message {session_id: "<id>"} saying the hold is cleared and it should resume, then finish.` }));
    process.exit(0);
  }
} catch { /* fail open */ }
passthrough();
