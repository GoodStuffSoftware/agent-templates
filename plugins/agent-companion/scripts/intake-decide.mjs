#!/usr/bin/env node
// intake-decide.mjs — the scout's decide step. No network, no model call.
//
//   node intake-decide.mjs queue [--stale-days N]
//        Print one JSON object:
//          releases[]  { version, rec, finding }  one decide finding each: a Claude Code
//                      release with an item that could change a hook, guard or option
//          quiet[]     versions with nothing that touches this plugin: mark them decided,
//                      write no finding
//          stale[]     { kind, ageDays, finding }  scout signals unacknowledged past the
//                      threshold (default 7 days)
//          notes[]     why a part was skipped
//        Each finding has the findings-store fields (docId, source, title, detail <= 300
//        chars, url, impact, expect "decide", firstSeen, lastSeen, lookedAt null, useful null).
//   node intake-decide.mjs mark <version>...
//        Record releases as decided. Run it only after the finding exists in the store
//        (or, for the quiet list, straight away). A release not marked is queued again.
//
// Exit codes: 0 ok, 2 bad usage.

import { readFileSync } from 'node:fs';
import { stateFile, stateDir, opt, scoutSuppressed } from '../hooks/lib/context.mjs';
import { buildQueue } from './lib/intake-decide.mjs';
import { markDecided } from './lib/release-watch.mjs';
import { STALE_DAYS } from './lib/scout-handoff.mjs';

const args = process.argv.slice(2);
const cmd = args[0];

function usage(msg) {
  if (msg) process.stderr.write(`intake-decide: ${msg}\n`);
  process.stderr.write('usage: intake-decide.mjs queue [--stale-days N] | mark <version>...\n');
  process.exit(2);
}

if (cmd === 'queue') {
  const i = args.indexOf('--stale-days');
  const staleDays = i >= 0 ? Number(args[i + 1]) : STALE_DAYS;
  if (!Number.isFinite(staleDays) || staleDays < 0) usage('--stale-days needs a number');
  let running = null;
  try { running = JSON.parse(readFileSync(stateFile('baseline.json'), 'utf8')).version; } catch { /* scout has not run */ }
  const hidden = scoutSuppressed();
  const q = buildQueue({
    stateDirPath: stateDir(),
    staleDays,
    skipKinds: [...hidden],
    releases: opt('release_watch', true) && !hidden.has('cli_release_available'),
    runningVersion: running,
  });
  process.stdout.write(`${JSON.stringify(q, null, 2)}\n`);
  process.exit(0);
}

if (cmd === 'mark') {
  const versions = args.slice(1).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  if (versions.length === 0 || versions.length !== args.length - 1) usage('mark needs one or more x.y.z versions');
  const ok = markDecided(stateFile('release-watch.json'), versions);
  process.stdout.write(`${ok ? 'decided' : 'FAILED to record'}: ${versions.join(' ')}\n`);
  process.exit(ok ? 0 : 1);
}

usage(cmd ? `unknown command ${cmd}` : 'no command');
