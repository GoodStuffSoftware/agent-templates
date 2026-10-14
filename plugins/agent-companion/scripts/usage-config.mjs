#!/usr/bin/env node
// usage-config.mjs — inspect the daily usage analysis configuration.
//
//   node scripts/usage-config.mjs check           validate every layer; exit 1 on any error or refusal
//   node scripts/usage-config.mjs explain <id>    winning layer per field, shadowed values, refusals
//                                                 (<id> is a scenario id, or "environment[.path]")
//   node scripts/usage-config.mjs list            scenarios with layer, severity and state
//
// Flags: --json   machine output
//        --root DIR   state root (default: the plugin's state root; test seam)
//        --cwd DIR    also look for a project layer in DIR's repository (repeatable, or comma list);
//                     the current directory is always included
//        --shipped FILE   test seam for the shipped defaults
//        --no-signal  do not write/remove state/usage-analysis-config-invalid.json
//
// The runner (a later batch) calls the same library; this file is read-only
// apart from that marker, and spawns only a window-hidden `git rev-parse`.

import { stateRootPath } from '../hooks/lib/context.mjs';
import { isMain } from './lib/is-main.mjs';
import { loadConfig, listScenarios, explain, renderExplain, SHIPPED_DEFAULTS_PATH } from './lib/usage/config.mjs';
import { configMetricRegistry } from './lib/usage/metrics/index.mjs';

function parseArgs(argv) {
  const o = { cmd: null, rest: [], json: false, root: null, cwds: [], shipped: null, signal: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--no-signal') o.signal = false;
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--shipped') o.shipped = argv[++i];
    else if (a === '--cwd') o.cwds.push(...String(argv[++i] || '').split(',').filter(Boolean));
    else if (a.startsWith('--')) return { error: `unknown flag ${a}` };
    else if (!o.cmd) o.cmd = a;
    else o.rest.push(a);
  }
  return o;
}

export function main(argv, { out = (s) => process.stdout.write(`${s}\n`), cwd = process.cwd() } = {}) {
  const o = parseArgs(argv);
  if (o.error) { out(o.error); return 2; }
  if (!['check', 'explain', 'list'].includes(o.cmd)) { out('usage: usage-config.mjs check | explain <id> | list  [--json] [--root DIR] [--cwd DIR]'); return 2; }
  if (o.cmd === 'explain' && !o.rest[0]) { out('explain needs a scenario id (or "environment")'); return 2; }
  const cfg = loadConfig({
    root: o.root || stateRootPath(),
    cwds: [cwd, ...o.cwds],
    shippedPath: o.shipped || SHIPPED_DEFAULTS_PATH,
    writeSignal: o.signal,
    metrics: configMetricRegistry(),
  });
  if (o.cmd === 'list') {
    const rows = listScenarios(cfg);
    if (o.json) out(JSON.stringify(rows, null, 2));
    else for (const r of rows) out(`${r.id.padEnd(40)} ${r.layer.padEnd(24)} ${r.severity.padEnd(6)} ${r.state}${r.why ? `  (${r.why})` : ''}`);
    return 0;
  }
  if (o.cmd === 'explain') {
    const e = explain(cfg, o.rest[0]);
    out(o.json ? JSON.stringify(e, null, 2) : renderExplain(e));
    return e.kind === 'missing' ? 1 : 0;
  }
  // check
  const projects = cfg.projects.map((p) => `${p.label}:${p.status}`);
  if (o.json) out(JSON.stringify({ ok: cfg.problems.length === 0, problems: cfg.problems, warnings: cfg.resolved.warnings, layers: cfg.layers.map((l) => ({ layer: l.layer, label: l.label, path: l.path, status: l.status })) }, null, 2));
  else {
    out(`shipped: ${cfg.shipped.status}; user: ${cfg.user.status}; projects: ${projects.length ? projects.join(', ') : 'none'}`);
    for (const p of cfg.problems) { out(`${p.layer} (${p.kind}) ${p.path || ''}`); for (const m of p.messages) out(`  ${m}`); }
    for (const w of cfg.resolved.warnings) out(`warning: ${w}`);
    out(cfg.problems.length ? `FAIL: ${cfg.problems.length} problem group(s)` : 'ok');
  }
  return cfg.problems.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
