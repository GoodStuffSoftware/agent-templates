// SessionStart: journal a change of the effective model, effort, plugin version
// or option digest (telemetry/settings-changes.jsonl). Silent: no stdout, no
// context. Fail-open: nothing here may reach session start.
// Also (0.31.59) notes which claude.ai account is in use (hooks/lib/account.mjs noteAccount: state/account-history.jsonl, written only
// when it differs from the last entry, nothing when unchanged), so an account switch is dated to the next session start.
import { readStdin, passthrough, sessionIsSubagent } from './lib/context.mjs';
import { journalSettings } from './lib/settings-journal.mjs';
import { noteAccount } from './lib/account.mjs';

try {
  const p = readStdin();
  if (p && !sessionIsSubagent(p)) journalSettings(p);
} catch {
  // fail open
}
try { noteAccount(); } catch { /* fail open */ }
passthrough();
