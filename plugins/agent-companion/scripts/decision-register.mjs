#!/usr/bin/env node
// The decision register's command line. No model call, no network.
//
//   node scripts/decision-register.mjs --check                 validate the register, print the errors
//   node scripts/decision-register.mjs --evaluate [--now ISO] [--changelog <file>]
//                                                              evaluate now (forced) and print the summary;
//                                                              --changelog also scans the changelog text in
//                                                              <file> (a hand run of the changelog triggers, it writes state;
//                                                              --changelog alone implies --evaluate)
//   node scripts/decision-register.mjs --detail                print the detail file path
//   node scripts/decision-register.mjs --path                  print the register path
//
// Exits 0 whatever the register holds: a broken register is a message, not a failure of this
// command. AGENT_COMPANION_STATE_DIR moves the state root, AGENT_COMPANION_FAKE_NOW the clock.

import { readFileSync } from 'node:fs';
import { loadRegister, registerPath, detailPath, runRegister, nowMs } from './lib/decision-register.mjs';
import { parseChangelog } from './lib/release-watch.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const say = (s) => process.stdout.write(`${s}\n`);

try {
  if (has('--check')) {
    const file = registerPath();
    const r = loadRegister(file);
    if (r.ok) {
      const n = r.register.decisions.length;
      const trig = r.register.decisions.reduce((a, d) => a + d.triggers.length, 0);
      say(`OK: ${file} (${n} decision${n === 1 ? '' : 's'}, ${trig} trigger${trig === 1 ? '' : 's'})`);
    } else if (r.absent) {
      say(`No register at ${file}. An absent register is not an error.`);
    } else {
      say(`INVALID: ${file} (${r.errors.length} error${r.errors.length === 1 ? '' : 's'})`);
      for (const e of r.errors) say(`  - ${e}`);
    }
  } else if (has('--evaluate') || has('--changelog')) {
    const nowArg = val('--now');
    const nowT = nowArg ? Date.parse(nowArg) : nowMs();
    let parsed = null;
    const clFile = val('--changelog');
    if (has('--changelog')) {
      if (!clFile || clFile.startsWith('--')) throw new Error('--changelog needs a file');
      parsed = parseChangelog(readFileSync(clFile, 'utf8'));
    }
    say(JSON.stringify(runRegister({ nowT: Number.isFinite(nowT) ? nowT : nowMs(), force: true, parsed })));
  } else if (has('--detail')) {
    say(detailPath());
  } else if (has('--path')) {
    say(registerPath());
  } else {
    say('usage: decision-register.mjs --check | --evaluate [--now <ISO>] [--changelog <file>] | --detail | --path');
  }
} catch (e) {
  say(`error: ${String((e && e.message) || e).slice(0, 300)}`);
}
process.exit(0);
