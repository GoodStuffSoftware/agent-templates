#!/usr/bin/env node
// api-credits.mjs — the API-credit governor (ledger: <state root>/state/api-credits.json).
//
//   node api-credits.mjs decide <category>              prints "api" or "plan", then one reason line
//   node api-credits.mjs record <category> <usd> <meta> appends spend
//   node api-credits.mjs status                         spend by category, the pace, what is left
//   node api-credits.mjs summary                        one line: "API credits: reviews $X of $100, cycle day N"
//   node api-credits.mjs probe                         one tiny haiku Messages call on the key; reports tokens and dollar cost, books it
//
// Categories: review, overflow, rater. Any error, a missing key or an unreadable ledger
// answers "plan". `--now <ISO time>` is a test seam. Settings: api_credits_* plugin
// options (see README "API credits"). Exit codes: 0 ok, 2 bad usage, 1 probe failed.

import { isMain } from './lib/is-main.mjs';
import { CATEGORIES, decide, record, status, summaryLine, loadConfig } from './lib/api-credits.mjs';
import { runApi } from './lib/api-run.mjs';

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), env = process.env, fetchImpl, endpoint, sleep, cfg: cfgIn } = {}) {
  const args = [];
  let now = Date.now();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--now') { now = Date.parse(argv[++i]); if (!Number.isFinite(now)) { out('bad --now'); return 2; } } else args.push(argv[i]);
  }
  const [cmd, ...rest] = args;
  let cfg;
  try { cfg = cfgIn || loadConfig(); } catch { cfg = null; }
  if (cmd === 'decide') {
    if (!cfg) { out('plan'); out('failed closed: unreadable configuration'); return 0; }
    const d = decide(rest[0], { now, cfg, env });
    out(d.decision); out(d.reason);
    return 0;
  }
  if (!cfg) { out('unreadable configuration'); return 2; }
  if (cmd === 'record') {
    if (!CATEGORIES.includes(rest[0]) || rest[1] === undefined) { out('usage: api-credits.mjs record <review|overflow|rater> <usd> <meta>'); return 2; }
    try { const r = record(rest[0], rest[1], rest.slice(2).join(' '), { now, cfg }); out(`recorded; ${rest[0]} total $${r.spent.toFixed(2)} in ${r.n} item(s)`); return 0; } catch (e) { out(`record failed: ${e.message}`); return 2; }
  }
  if (cmd === 'status') { out(status({ now, cfg, env }).text); return 0; }
  if (cmd === 'summary') { out(summaryLine({ now, cfg })); return 0; }
  if (cmd === 'probe') {
    const r = await runApi({
      prompt: 'Reply with exactly one word: ok', model: 'haiku', tools: false, maxTokens: 32, category: 'review', meta: 'probe', cfg, now, env,
      ...(fetchImpl ? { fetchImpl } : {}), ...(endpoint ? { endpoint } : {}), ...(sleep ? { sleep } : {}),
    });
    if (r.ok) {
      const tin = r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite;
      out(`probe ok: HTTP 200 from the Messages API, ${r.model}, ${tin} tokens in, ${r.tokens.output} out, cost $${r.usd.toFixed(5)} (usage x list price), answered "${r.text.trim().slice(0, 40)}". Compare with the Console credit balance; a successful probe also clears a tripped breaker.`);
      return 0;
    }
    out(r.unavailable ? `API review unavailable: ${r.reason}` : `probe failed: ${r.reason}`);
    return 1;
  }
  out('usage: api-credits.mjs decide <category> | record <category> <usd> <meta> | status | summary | probe');
  return 2;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
