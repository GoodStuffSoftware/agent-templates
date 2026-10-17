#!/usr/bin/env node
// scout-ack.mjs — record that a scout signal was triaged, list the ledger, show the hand-off.
//
//   node scout-ack.mjs show                       print scout-delta.md (re-evaluated now)
//   node scout-ack.mjs list [--json]              acks with kind, match, note, expiry, state
//   node scout-ack.mjs add <kind> --note "<text>" [--match "<detail text>"]
//                          [--days N | --expires YYYY-MM-DD]
//   node scout-ack.mjs remove <id>
//
// An ack stops a signal counting as unacknowledged until it expires (default 14 days),
// or until the signal changes materially (see scripts/lib/scout-handoff.mjs). `--match`
// narrows the ack to entries whose detail contains that text (case-insensitive).
// State lives under <state root>/state/ (scout-acks.json); after every change the
// scout-delta.json / scout-delta.md view is rewritten. No network, no model.
// Exit codes: 0 ok, 2 bad usage or unknown id.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { stateFile, opt } from '../hooks/lib/context.mjs';
import {
  readAcks, writeAcks, readState, addAck, removeAck, parseExpiry, refreshView, paths,
  ackCommandFor, ackIsExpired, materialChange, ledgerUnreadable, withAcksLock, DEFAULT_REPEAT_DAYS,
} from './lib/scout-handoff.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = dirname(stateFile('scout-latest.json'));
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? '' : v;
}
function positionals() {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { if (!['json'].includes(args[i].slice(2))) i += 1; continue; }
    out.push(args[i]);
  }
  return out;
}
function usage(msg) {
  if (msg) process.stderr.write(`scout-ack: ${msg}\n`);
  process.stderr.write('usage: scout-ack.mjs show | list [--json] | add <kind> --note "<text>" [--match "<text>"] [--days N | --expires YYYY-MM-DD] | remove <id>\n');
  process.exit(2);
}

const threshold = opt('scout_repeat_days', DEFAULT_REPEAT_DAYS);
const refresh = () => refreshView(dir, { threshold, ackCommand: ackCommandFor(root) });
const [cmd, ...rest] = positionals();
const nowMs = Date.now();

if (cmd === 'show') {
  const view = refresh();
  if (!view) { process.stdout.write('No scout hand-off state yet: the scout has not run on this machine since this feature was installed.\n'); process.exit(0); }
  process.stdout.write(readFileSync(paths(dir).md, 'utf8'));
  process.exit(0);
}

if (cmd === 'list') {
  if (ledgerUnreadable(dir)) process.stderr.write(`scout-ack: ${paths(dir).acks} cannot be read; showing no acknowledgements. The next add or remove keeps a copy as scout-acks.json.bad.\n`);
  const acks = readAcks(dir);
  const state = readState(dir);
  const rows = acks.acks.map((a) => ({
    id: a.id, kind: a.kind, match: a.match || null, note: a.note, expires: a.expires,
    status: ackIsExpired(a, nowMs) ? 'expired' : (state && materialChange(a, state.kinds) ? 'voided (signal changed)' : 'active'),
  }));
  if (args.includes('--json')) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); process.exit(0); }
  if (rows.length === 0) { process.stdout.write('No acknowledgements.\n'); process.exit(0); }
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.kind}${r.match ? ` [${r.match}]` : ''}  until ${String(r.expires).slice(0, 10)}  ${r.status}  ${r.note}\n`);
  }
  process.exit(0);
}

if (cmd === 'add') {
  const kind = rest[0];
  if (!kind) usage('add needs a signal kind');
  const note = flag('note');
  if (!note) usage('add needs --note "<decision reference or reason>"');
  for (const f of ['expires', 'match', 'days']) if (flag(f) === '') usage(`--${f} needs a value`);
  const exp = parseExpiry(flag('expires'), nowMs, { days: flag('days') });
  if (exp.error) usage(exp.error);
  const state = readState(dir);
  if (!state && existsSync(paths(dir).state)) {
    process.stderr.write('scout-ack: the scout hand-off state file (scout-delta-state.json) is corrupt or unreadable, so an ack now would remember nothing; run the scout once to rewrite it, then add the ack.\n');
    process.exit(1);
  }
  if (!state) {
    process.stderr.write('scout-ack: no scout hand-off state yet, so an ack now would remember nothing and be voided by the first run; run the scout once first, then add the ack.\n');
    process.exit(1);
  }
  let ack;
  try {
    ack = withAcksLock(dir, () => {
      const added = addAck(readAcks(dir), { kind, match: flag('match'), note, expires: exp.iso, kinds: state.kinds, nowMs });
      writeAcks(dir, added.acks);
      return added.ack;
    }, { failOpen: false });
  } catch (e) { process.stderr.write(`scout-ack: ${e && e.message}\n`); process.exit(1); }
  refresh();
  const seen = ack.snapshot.count;
  process.stdout.write(`acknowledged ${ack.kind}${ack.match ? ` [${ack.match}]` : ''} as ${ack.id} until ${ack.expires.slice(0, 10)} (${seen} current entr${seen === 1 ? 'y' : 'ies'} covered${seen === 0 ? '; the signal is not firing now, so any new entry will raise it' : ''})\n`);
  process.exit(0);
}

if (cmd === 'remove') {
  const id = rest[0];
  if (!id) usage('remove needs an ack id (see list)');
  let removed;
  try {
    removed = withAcksLock(dir, () => {
      const out = removeAck(readAcks(dir), id);
      if (out.removed) writeAcks(dir, out.acks);
      return out.removed;
    }, { failOpen: false });
  } catch (e) { process.stderr.write(`scout-ack: ${e && e.message}\n`); process.exit(1); }
  if (!removed) { process.stderr.write(`scout-ack: no ack with id ${id}\n`); process.exit(2); }
  refresh();
  process.stdout.write(`removed ${removed.id} (${removed.kind}${removed.match ? ` [${removed.match}]` : ''})\n`);
  process.exit(0);
}

usage(cmd ? `unknown command ${cmd}` : 'no command');
