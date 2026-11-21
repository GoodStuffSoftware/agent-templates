// PreToolUse on Write and Edit, inside a SUBAGENT only. An Opus-model helper whose brief declares ROLE: operate or
// ROLE: other must not edit repo source files: code edits go to a Sonnet writer (lib/opus-code-edit.mjs). .md files,
// detail, handoff and plan files, and paths outside a git repo are never denied. The lead's own calls carry no agent_id
// and exit at once. Off when opus_writer_policy is "allow". Each deny is a row in denials.jsonl (guard opus-code-edit). Fails open.

import { readStdin, opt, passthrough, deny, callerIsSubagent, recordDenial } from './lib/context.mjs';
import { checkOpusCodeEdit } from './lib/opus-code-edit.mjs';

try {
  if (String(opt('opus_writer_policy', 'sonnet')).toLowerCase() === 'allow') passthrough();
  const p = readStdin();
  if (!['Write', 'Edit'].includes(p.tool_name) || !callerIsSubagent(p)) passthrough();
  const r = checkOpusCodeEdit(p);
  if (r.action !== 'deny') passthrough();
  try { recordDenial('opus-code-edit', p, `${r.row.role}: ${r.row.file}`); } catch { /* telemetry never blocks */ }
  deny(r.reason);
} catch { /* fail open */ }
passthrough();
