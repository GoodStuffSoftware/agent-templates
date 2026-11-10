// SessionStart -- one line naming the project, its project tier and what each change risk needs.
//
// The tier is the user's: <configDir>/project-tiers.json, edited with `scripts/project-tiers.mjs`
// (`/ac tier`). With no file the project is tier risk. Lead sessions only (a subagent that
// compacted has no use for it; a folder outside a git repo gets none), its own context line, not a standing rule: the rules block has
// a character budget this line would eat into. `sessionLine: false` in the file turns it off.
// Writers and reviewers get their clause from the spawn guard (lib/tier-clause.mjs), not from here.
//
// Design rule that outranks every feature here (see hooks/lib/context.mjs):
// A HOOK MUST NEVER BREAK A SESSION. Wrapped end to end; any failure degrades to passthrough.

import { readStdin, sessionIsSubagent, isCloudSession } from './lib/context.mjs';
import { tierDetail } from './lib/project-tier.mjs';
import { tierLine } from './lib/tier-text.mjs';

function silent() {
  process.stdout.write('{}');
  process.exit(0);
}

try {
  const p = readStdin();
  if (sessionIsSubagent(p)) silent();
  // A cloud sandbox has none of the user's per-machine files: the table is the user's setting.
  if (isCloudSession()) silent();
  const d = tierDetail(p?.cwd || process.cwd());
  if (d.config?.sessionLine === false) silent();
  // Outside a git repo there is no project to name: no line (the spawn clauses still say the default tier).
  if (!d.project) silent();
  const line = tierLine(d.tier, d.project, { reviewEveryChange: !!d.config?.reviewEveryChange });
  if (!line) silent();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line },
  }));
  process.exit(0);
} catch {
  silent(); // never break a session
}
