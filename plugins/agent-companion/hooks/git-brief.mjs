// SessionStart and SubagentStart — put ONE line of git state in the agent's
// context so it does not spend turns on `git status` / `git fetch` /
// `git rev-list` to find out where it is. The line comes from
// scripts/git-brief.mjs, which also carries the freshness and timeout policy
// for the fetch it does (5 minutes; 1.5 s cap; never prompts). The line names
// the refresh command, so a later question ("is X on main?") is one script
// call, not a git sequence.
//
// Selected by argv, like subagent-brevity.mjs: `--event session-start` or
// `--event subagent-start`. The main session gets it at every SessionStart
// source (startup, resume, clear, compact: after a compaction the old line is
// gone and the state has moved on).
//
// git_brief (default true) is the trial switch: `false`, or
// CLAUDE_PLUGIN_OPTION_GIT_BRIEF=0 in the environment, makes this hook do
// nothing at all (no git call, no output, no telemetry row).
//
// Telemetry, telemetry/git-brief.jsonl: one `inject-session` or
// `inject-subagent` row per run, with the characters injected (0 when there
// was nothing to say: not a repository, an error), whether a fetch ran, and
// the duration. The script's own CLI runs write `run` / `landed` rows.
//
// Fails open: any error prints nothing and exits 0.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin, opt, passthrough, appendLog } from './lib/context.mjs';
import { gitBrief } from '../scripts/git-brief.mjs';

const argv = process.argv.slice(2);
const evIdx = argv.indexOf('--event');
const EVENT = evIdx >= 0 ? argv[evIdx + 1] : undefined;

try {
  if (!opt('git_brief', true)) passthrough();
  if (EVENT !== 'session-start' && EVENT !== 'subagent-start') passthrough();
  const p = readStdin();
  const t0 = Date.now();
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  const res = gitBrief({ cwd });

  const root = (process.env.CLAUDE_PLUGIN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)))).replace(/\\/g, '/');
  const text = res.line
    ? `Git: ${res.line} | refresh instead of git status/fetch: node "${root}/scripts/git-brief.mjs" [landed <sha|branch>]`
    : '';

  appendLog('git-brief.jsonl', {
    at: new Date().toISOString(),
    session_id: String(p.session_id ?? ''),
    agent_type: p.agent_type,
    event: EVENT === 'session-start' ? 'inject-session' : 'inject-subagent',
    chars: text.length,
    fetched: res.fetched,
    duration_ms: Date.now() - t0,
  });

  if (!text) passthrough();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: EVENT === 'session-start' ? 'SessionStart' : 'SubagentStart',
      additionalContext: text,
    },
  }));
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
