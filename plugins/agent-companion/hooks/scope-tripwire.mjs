// PreToolUse on Write, inside a SUBAGENT only. Counts the new files a helper creates that its
// brief does not name (lib/scope-tripwire.mjs): a lookup-kind helper is denied at the first one,
// a writer gets one note at the third and is denied from the fourth. The lead's own Writes carry
// no agent_id and exit at once. Options: scope_tripwire (default true), scope_tripwire_lookup_deny
// (1), scope_tripwire_writer_note (3), scope_tripwire_writer_deny (4). Each note or deny is one row
// in telemetry/scope-tripwire.jsonl. Fails open.

import { readStdin, opt, passthrough, deny, callerIsSubagent, appendLog, recordDenial } from './lib/context.mjs';
import { checkNewFile, DEFAULTS } from './lib/scope-tripwire.mjs';

try {
  if (!opt('scope_tripwire', true)) passthrough();
  const p = readStdin();
  if (p.tool_name !== 'Write' || !callerIsSubagent(p)) passthrough();
  const r = checkNewFile(p, {
    opts: {
      lookupDeny: Math.max(1, opt('scope_tripwire_lookup_deny', DEFAULTS.lookupDeny)),
      writerNote: Math.max(1, opt('scope_tripwire_writer_note', DEFAULTS.writerNote)),
      writerDeny: Math.max(1, opt('scope_tripwire_writer_deny', DEFAULTS.writerDeny)),
    },
  });
  if (r.action === 'pass') passthrough();
  appendLog('scope-tripwire.jsonl', { at: new Date().toISOString(), session_id: p.session_id, action: r.action, ...r.row });
  if (r.action === 'deny') {
    try { recordDenial('scope-tripwire', p, r.reason); } catch { /* telemetry never blocks */ }
    deny(r.reason);
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: r.note },
  }));
  process.exit(0);
} catch { /* fail open */ }
passthrough();
