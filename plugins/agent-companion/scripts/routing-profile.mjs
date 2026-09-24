#!/usr/bin/env node
// /ac routing — the per-user routing profile (ADR 0003 slice 2).
//
//   node routing-profile.mjs set <type> --model M --effort E [--because "..."] [--waive-floor elevated]
//   node routing-profile.mjs set code-review --effort E        (a parity type: minimum effort only)
//   node routing-profile.mjs unset <type>
//   node routing-profile.mjs show [--json]
//   node routing-profile.mjs why <type> [--writer M/E] [--json]
//   node routing-profile.mjs rollback --row <type>
//   node routing-profile.mjs rollback --to <revision>
//
// Every write goes through scripts/lib/routing-profile-store.mjs
// commitChange() — one validated writer, locked, atomic, journalled. `why` is
// exactly `recommend.mjs --type <type> --explain`: one explain stack, not two.
// The profile lives at <stateRoot>/config/routing-profile.json; the
// routing_profile option is the kill switch (off: only the shipped table
// routes, and the file is left untouched).
//
// Exit codes: 0 done, 1 refused / conflict / invalid file / not found, 2 usage.

import { join } from 'node:path';
import {
  opt, routingProfileState, taskTypeDef, profileRowRefusal, routingProfileInvalidMarkerPath,
} from '../hooks/lib/context.mjs';
import { typeShapeErrors } from '../hooks/lib/routing-profile.mjs';
import {
  setRow, unsetRow, rollbackRow, rollbackTo, inspect, ProfileWriteError,
} from './lib/routing-profile-store.mjs';
import { spawnSyncHidden } from './lib/proc.mjs';

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const has = (n) => rest.includes(n);
const val = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const positional = () => {
  const out = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith('--')) { if (!['--json'].includes(rest[i])) i += 1; continue; }
    out.push(rest[i]);
  }
  return out;
};

const USAGE = [
  'usage: routing-profile.mjs <command>',
  '  set <type> --model M --effort E [--because "..."] [--waive-floor elevated]',
  '  set code-review --effort E          (parity type: a minimum effort, never a model)',
  '  unset <type>',
  '  show [--json]',
  '  why <type> [--writer M/E] [--json]',
  '  rollback --row <type> | rollback --to <revision>',
].join('\n');

function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

function report(res, verb) {
  if (has('--json')) {
    console.log(JSON.stringify({ ok: true, revision: res.revision, journal: res.entries.map((e) => ({ revision: e.revision, action: e.action, type: e.type })) }, null, 2));
  } else {
    console.log(`${verb} — routing profile now at revision ${res.revision}.`);
    if (res.entries.length > 1) {
      for (const e of res.entries.slice(0, -1)) console.log(`  (journalled first: revision ${e.revision} ${e.action})`);
    }
    if (!opt('routing_profile', true)) {
      console.log('  NOTE: the routing_profile option is OFF (kill switch) — the file is written but nothing routes through it until it is on.');
    }
  }
}

function fail(e) {
  if (e instanceof ProfileWriteError) {
    if (has('--json')) console.log(JSON.stringify({ ok: false, code: e.code, error: e.message, details: e.details }, null, 2));
    else {
      console.error(e.message);
      for (const d of (e.details || []).slice(1)) console.error(`  also: ${d}`);
    }
    process.exit(e.code === 'usage' ? 2 : 1);
  }
  throw e;
}

const label = (row) => (row.model ? `${row.model}${row.effort ? '/' + row.effort : ''}` : `min effort ${row.effort || '?'}`);

function show() {
  const v = inspect();
  const on = opt('routing_profile', true);
  const state = v.status === 'ok' ? { status: 'ok', profile: v.profile, revision: v.profile.revision } : { status: v.status, profile: null };
  const rows = [];
  for (const [type, row] of Object.entries(v.profile?.rows || {})) {
    const td = taskTypeDef(type, { state });
    let status;
    if (row && row.state === 'retired') status = 'retired';
    else {
      const reason = profileRowRefusal(type, row, { typeDef: td ? td.def : null, mode: 'read' });
      status = reason ? `ignored: ${reason}` : (on ? 'applies' : 'would apply (routing_profile is off)');
    }
    rows.push({ type, row, status, origin: td ? td.origin : null });
  }
  const types = Object.entries(v.profile?.types || {}).map(([name, def]) => {
    const td = taskTypeDef(name, { state });
    const shape = typeShapeErrors(def);
    return {
      name, def,
      status: td && td.origin === 'shipped' ? 'shadowed by the shipped type of the same name'
        : td ? 'ok' : `invalid: ${shape[0] || 'kind or consequence is not in the routing table'}`,
    };
  });
  const out = {
    path: v.files.profile,
    journal: v.files.journal,
    option: on ? 'on' : 'off',
    status: v.status,
    reason: v.reason || null,
    errors: v.errors,
    revision: v.profile ? v.profile.revision : null,
    schemaVersion: v.profile ? v.profile.schemaVersion : null,
    basedOn: v.profile ? v.profile.basedOn ?? null : null,
    objective: v.profile ? v.profile.objective ?? 'api-cost' : null,
    journalEntries: v.entries.length,
    journalErrors: v.journalErrors,
    journalMatches: v.journalMatches,
    rows,
    types,
    recent: v.entries.slice(-10).map((e) => ({ revision: e.revision, at: e.at, action: e.action, type: e.type })),
    resolver: on ? routingProfileState().status : 'off',
    invalidMarker: routingProfileInvalidMarkerPath(),
  };
  if (has('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`routing profile: ${out.path}`);
  console.log(`option:          routing_profile ${out.option}${out.option === 'off' ? ' (kill switch: only the shipped table routes; the file is left untouched)' : ''}`);
  if (v.status === 'absent') {
    console.log('status:          no profile — every route comes from the shipped table.');
    console.log('                 `set <type> --model M --effort E --because "..."` writes the first row.');
  } else if (v.status !== 'ok') {
    console.log(`status:          INVALID (${v.reason}) — ignored as a whole; the shipped table routes.`);
    for (const e of v.errors) console.log(`                 - ${e}`);
  } else {
    console.log(`status:          ok — revision ${out.revision}, schema v${out.schemaVersion}, objective ${out.objective}` +
      (out.basedOn ? `, based on table v${out.basedOn.tableVersion ?? '?'} (${out.basedOn.tableUpdated ?? '?'})` : ''));
  }
  console.log(`journal:         ${out.journalEntries} entr${out.journalEntries === 1 ? 'y' : 'ies'}` +
    (v.journalErrors.length ? ` — CANNOT BE FOLDED: ${v.journalErrors[0]}`
      : out.journalMatches === false ? ' — does not match the file (hand-edited?); the next write journals the file as it stands'
        : ''));
  if (rows.length) {
    console.log('\nrows:');
    for (const r of rows) {
      const row = r.row || {};
      console.log(`  ${r.type.padEnd(22)} ${String(row.state || '?').padEnd(8)} ${label(row).padEnd(18)} ${String(row.source || '?').padEnd(18)}` +
        ` since ${row.since || '?'}${row.reviewBy ? `, review by ${row.reviewBy}` : ''}` +
        `${row.waivesFloor ? `, WAIVES F5 (${row.waivesFloor})` : ''}${r.origin === 'local' ? ', local type' : ''}`);
      console.log(`  ${''.padEnd(22)} -> ${r.status}${row.note ? `; note: ${row.note}` : ''}`);
    }
  } else if (v.status === 'ok') {
    console.log('\nrows:            none');
  }
  if (types.length) {
    console.log('\nlocal types:');
    for (const t of types) {
      console.log(`  ${t.name.padEnd(22)} w=${t.def?.weight} ${t.def?.kind} ${t.def?.consequence} — ${t.status}`);
    }
  }
  if (out.recent.length) {
    console.log('\nrecent changes (rollback --to <revision> restores any of them):');
    for (const e of out.recent) console.log(`  rev ${String(e.revision).padEnd(4)} ${e.at || ''}  ${e.action}${e.type ? ' ' + e.type : ''}`);
  }
}

function why() {
  const [type] = positional();
  if (!type) usage('why needs a task type');
  const args = [join(import.meta.dirname, 'recommend.mjs'), '--type', type, '--explain'];
  if (val('--writer')) args.push('--writer', val('--writer'));
  if (has('--json')) args.push('--json');
  const r = spawnSyncHidden(process.execPath, args, { encoding: 'utf8', stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

try {
  switch (cmd) {
    case 'set': {
      const [type] = positional();
      if (!type) usage('set needs a task type');
      const waive = val('--waive-floor');
      if (waive !== undefined && waive !== 'elevated') usage('--waive-floor takes only "elevated" (F5); F1-F4 cannot be waived');
      const res = setRow(type, { model: val('--model'), effort: val('--effort'), because: val('--because'), waiveFloor: waive || null });
      report(res, `set ${type}`);
      break;
    }
    case 'unset': {
      const [type] = positional();
      if (!type) usage('unset needs a task type');
      report(unsetRow(type), `retired the ${type} row`);
      break;
    }
    case 'show': show(); break;
    case 'why': why(); break;
    case 'rollback': {
      const row = val('--row');
      const to = val('--to');
      if ((row === undefined) === (to === undefined)) usage('rollback needs exactly one of --row <type> or --to <revision>');
      report(row !== undefined ? rollbackRow(row) : rollbackTo(to), row !== undefined ? `rolled back the ${row} row` : `rolled the profile back to revision ${to}`);
      break;
    }
    case undefined: case 'help': case '--help': case '-h':
      console.log(USAGE);
      break;
    default:
      usage(`unknown command "${cmd}"`);
  }
} catch (e) { fail(e); }
