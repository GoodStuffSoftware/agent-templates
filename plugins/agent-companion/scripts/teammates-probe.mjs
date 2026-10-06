#!/usr/bin/env node
// Manual probe: do desktop teammates (agent teams) work on the installed
// Claude Code? Read-only: it reads the desktop app's newest build, counts four
// team strings in it, and looks for teams that list a teammate. It never
// spawns a model. See scripts/lib/teammates-watch.mjs for why the strings are
// only a hint and a created teammate is the verdict.
//
//   node scripts/teammates-probe.mjs [--since <ISO date>] [--json]
//
// Exit 0: a teammate was found since the date (default 2026-06-22, the day
// after the last desktop team that worked). Exit 1: none found.
//
// The decisive manual test, in a DESKTOP session of the build under test
// (the reuse rule depends on it, so it is worth the two minutes):
//   1. Spawn a named background worker: Agent { name: "probe-a", run_in_background: true,
//      subagent_type: "general-purpose", prompt: "Reply OK and stop." }.
//   2. Read <claude dir>/teams/session-<first 8 chars of the session id>/config.json.
//      A member besides team-lead means teammates work. Only the lead means the
//      worker was an ordinary subagent.
//   3. Re-run this script: it prints the same verdict from that file.

import { claudeDir } from '../hooks/lib/context.mjs';
import { LAST_WORKING_MS, desktopRoots, newestDesktopBuild, scanMarkers, teamEvidence } from './lib/teammates-watch.mjs';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const json = argv.includes('--json');
const sinceArg = val('--since');
const sinceMs = sinceArg ? Date.parse(sinceArg) : LAST_WORKING_MS;
if (!Number.isFinite(sinceMs)) {
  process.stderr.write(`teammates-probe: --since must be a date, got ${JSON.stringify(sinceArg)}\n`);
  process.exit(2);
}

const build = newestDesktopBuild(desktopRoots());
const markers = build ? scanMarkers(build.binary) : null;
const evidence = teamEvidence({ dir: claudeDir(), sinceMs });
const out = {
  since: new Date(sinceMs).toISOString(),
  desktopBuild: build ? build.version : null,
  markers,
  teamsWithTeammates: evidence.length,
  newest: evidence.length ? { name: evidence[evidence.length - 1].name, members: evidence[evidence.length - 1].members, createdAt: new Date(evidence[evidence.length - 1].createdAt).toISOString() } : null,
  teammatesAvailable: evidence.length > 0,
};

if (json) {
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} else {
  const lines = [
    `desktop build: ${out.desktopBuild || 'not found'}`,
    `team strings in the binary (a hint only, they are present while teammates do not work): ${markers ? Object.entries(markers).map(([k, v]) => `${k} ${v}`).join(', ') : 'unreadable'}`,
    `teams created since ${out.since.slice(0, 10)} that list a teammate: ${out.teamsWithTeammates}`,
    out.teammatesAvailable
      ? `VERDICT: teammates work (newest ${out.newest.createdAt.slice(0, 10)}, ${out.newest.members} member(s)).`
      : 'VERDICT: no teammate found. Run the manual test in the header of this script in a desktop session of the build under test, then re-run this.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}
process.exit(out.teammatesAvailable ? 0 : 1);
