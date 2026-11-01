#!/usr/bin/env node
// api-spend.mjs — the API-credit spend watch (Admin API cost report vs the governor ledger).
//
//   node api-spend.mjs check          prints one JSON object: { ok, line, notify: [{id, message}], ... }
//   node api-spend.mjs ack <alert-id> marks an alert done for this billing cycle
//
// `line` is "API credits: reviewers $X of $100 · total $Y of $200 · cycle day N" (plus
// "· unexplained $Z"), or "API credits: unavailable (<reason>)" on any key or API failure.
// `notify` holds the alerts not yet acknowledged this cycle. `--now <ISO time>` is a test seam.
// Settings: api_admin_key_source, api_spend_alerts, api_spend_reviewers_workspace (README
// "API spend watch"). Exit codes: 0 ok (also when unavailable), 2 bad usage.

import { isMain } from './lib/is-main.mjs';
import { check, ack, loadSpendConfig } from './lib/api-spend.mjs';

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), env = process.env, ...inject } = {}) {
  const args = [];
  let now = Date.now();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--now') { now = Date.parse(argv[++i]); if (!Number.isFinite(now)) { out('bad --now'); return 2; } } else args.push(argv[i]);
  }
  const [cmd, ...rest] = args;
  if (cmd === 'check') {
    let cfg = inject.cfg;
    try { cfg ||= loadSpendConfig(); } catch (e) {
      out(JSON.stringify({ ok: false, line: 'API credits: unavailable (unreadable configuration)', notify: [] }));
      return 0;
    }
    const r = await check({ now, cfg, env, ...inject });
    out(JSON.stringify(r));
    return 0;
  }
  if (cmd === 'ack') {
    try { out(JSON.stringify({ ok: true, ...ack(rest[0], { now, ...(inject.alertPath ? { path: inject.alertPath } : {}), ...(inject.cfg ? { cfg: inject.cfg } : {}) }) })); return 0; } catch (e) {
      out(JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 120) }));
      return 2;
    }
  }
  out('usage: api-spend.mjs check | ack <alert-id>');
  return 2;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
