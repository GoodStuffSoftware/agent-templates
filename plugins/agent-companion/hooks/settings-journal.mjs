// SessionStart: journal a change of the effective model, effort, plugin version
// or option digest (telemetry/settings-changes.jsonl). Silent: no stdout, no
// context. Fail-open: nothing here may reach session start.
import { readStdin, passthrough, sessionIsSubagent } from './lib/context.mjs';
import { journalSettings } from './lib/settings-journal.mjs';

try {
  const p = readStdin();
  if (p && !sessionIsSubagent(p)) journalSettings(p);
} catch {
  // fail open
}
passthrough();
