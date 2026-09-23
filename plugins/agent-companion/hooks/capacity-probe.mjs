// SessionStart -- surface a one-line machine-capacity estimate.
//
// Cheap and read-only: free memory, cpu count, and a concurrency budget
// derived from them. Deliberately skips the (best-effort, OS-shell-spawning)
// live-process count that scripts/capacity.mjs's CLI can do -- that costs
// tens of milliseconds spawning a shell, which is fine for a deliberate CLI
// run but not for a hook that fires on every session start alongside three
// other hooks sharing the same instruction budget. The math and policy are
// identical either way; only the process count is omitted here.
//
// Design rule that outranks every feature here (see hooks/lib/context.mjs):
// A HOOK MUST NEVER BREAK A SESSION. Wrapped end to end; any failure here
// degrades to passthrough, never a thrown error or a hung hook.

import { readStdin, opt, passthrough } from './lib/context.mjs';
import { buildReport, formatHookLine } from '../scripts/capacity.mjs';

try {
  readStdin();
  if (!opt('capacity_probe', true)) passthrough();

  const report = buildReport({ includeProcessCount: false });
  const line = formatHookLine(report);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line },
  }));
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
