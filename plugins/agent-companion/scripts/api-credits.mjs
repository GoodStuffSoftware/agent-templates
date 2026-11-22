#!/usr/bin/env node
// api-credits.mjs — the API-credit governor (ledger: <state root>/state/api-credits.json).
//
//   node api-credits.mjs decide <category> [--peek]     (--peek: do not advance the review alternation counter) prints "api" or "plan", then one reason line (billed spend from the Admin API plus booked spend after the last complete day; "booked only, not verified against billing" without an admin key or network)
//   node api-credits.mjs record <category> <usd> <meta> --api-key-source ANTHROPIC_API_KEY  appends spend; without the flag it is refused (exit 2, nothing booked, a line in api-credits-rejects.jsonl)
//   node api-credits.mjs status                         spend by category, the pace, what is left, the review limits in force, then billed spend (month and cycle, by workspace, key and model), the booked figure beside it, gaps, credits left (estimate), workspace limits
//   node api-credits.mjs record-fallback <review id> [--reason <r>]  marks a review as redone on the plan (the id api-review.mjs printed)
//   node api-credits.mjs reviews [--since <ISO date>] [--until <ISO date>]  real reviews only (no probe or measure rows): count, spend, median, stopped or fallen back
//   node api-credits.mjs summary                        one line: "API credits: reviews $X of the review share of the budget, cycle day N"
//   node api-credits.mjs probe                         one tiny haiku Messages call on the key; reports tokens and dollar cost, books it
//
// Categories: review, overflow, rater, workers (API worker runs, scripts/api-worker.mjs). Any error, a missing key or an unreadable ledger
// answers "plan". `--now <ISO time>` is a test seam. Settings: api_credits_* plugin
// options (see README "API credits"). Exit codes: 0 ok, 2 bad usage, 1 probe failed.

import { isMain } from './lib/is-main.mjs';
import { CATEGORIES, decide, record, recordFallback, reviewStats, reviewSummaryLine, reviewShareLines, status, summaryLine, billingStatusLines } from './lib/api-credits.mjs';
import { runApi, reviewLimitsLine } from './lib/api-run.mjs';
import { getBilling, loadSpendConfig } from './lib/api-spend.mjs';
import { opt } from '../hooks/lib/context.mjs';

// Overall wait for the billing snapshot; past it decide and status fall back to booked spend only.
export const BILLING_DEADLINE_MS = 10000;

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), env = process.env, fetchImpl, endpoint, sleep, cfg: cfgIn, billingFetch, readKey, billingCachePath, billingDeadlineMs = BILLING_DEADLINE_MS } = {}) {
  const args = [];
  let now = Date.now();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--now') { now = Date.parse(argv[++i]); if (!Number.isFinite(now)) { out('bad --now'); return 2; } } else args.push(argv[i]);
  }
  const peekAt = args.indexOf('--peek'); // 0.31.63: decide without advancing the review counter
  const peek = peekAt >= 0;
  if (peek) args.splice(peekAt, 1);
  const [cmd, ...rest] = args;
  let cfg;
  try { cfg = cfgIn || loadSpendConfig(); } catch { cfg = null; }
  // The billed-spend snapshot (Admin API, cached about 15 minutes). Never throws; { ok: false, reason } means booked only.
  const billingRaw = () => getBilling({ now, cfg, env, ...(billingFetch ? { fetchImpl: billingFetch } : {}), ...(readKey ? { readKey } : {}), ...(billingCachePath ? { cachePath: billingCachePath } : {}) });
  const billing = async () => {
    let t;
    const late = new Promise((r) => { t = setTimeout(() => r({ ok: false, reason: `billing fetch passed the ${Math.round(billingDeadlineMs / 1000)} s deadline` }), billingDeadlineMs); if (t.unref) t.unref(); });
    try { return await Promise.race([billingRaw(), late]); } finally { clearTimeout(t); }
  };
  if (cmd === 'decide') {
    if (!cfg) { out('plan'); out('failed closed: unreadable configuration'); return 0; }
    // Nothing is fetched for a category that fails closed anyway, and a failed or absent billing source never blocks the decision.
    const b = CATEGORIES.includes(rest[0]) ? await billing() : { ok: false };
    const d = decide(rest[0], { now, cfg, env, billing: b.ok ? b.snapshot : null, peek });
    out(d.decision); out(d.reason);
    return 0;
  }
  if (!cfg) { out('unreadable configuration'); return 2; }
  if (cmd === 'record') {
    const ki = rest.indexOf('--api-key-source');
    const apiKeySource = ki >= 0 ? (rest[ki + 1] ?? '') : null;
    const rr = ki >= 0 ? rest.filter((_, i) => i !== ki && i !== ki + 1) : rest;
    if (!CATEGORIES.includes(rr[0]) || rr[1] === undefined) { out('usage: api-credits.mjs record <review|overflow|rater|workers> <usd> <meta> --api-key-source ANTHROPIC_API_KEY'); return 2; }
    try { const r = record(rr[0], rr[1], rr.slice(2).join(' '), { now, cfg, apiKeySource }); out(`recorded; ${rr[0]} total $${r.spent.toFixed(2)} in ${r.n} item(s)`); return 0; } catch (e) { out(`record failed: ${e.message}`); return 2; }
  }
  if (cmd === 'record-fallback') {
    const ri = rest.indexOf('--reason');
    const reason = ri >= 0 ? rest.slice(ri + 1).join(' ') : '';
    const id = rest.filter((_, i) => ri < 0 || i < ri)[0];
    if (!id) { out('usage: api-credits.mjs record-fallback <review id> [--reason <reason>]'); return 2; }
    try {
      const r = recordFallback(id, reason, { now, cfg });
      out(r.found ? `fallback recorded for review ${id} ($${r.usd.toFixed(2)} spent on it${r.already ? '; it was already marked' : ''})` : `no review with id ${id} in the ledger; nothing recorded`);
      return r.found ? 0 : 1;
    } catch (e) { out(`record-fallback failed: ${e.message}`); return 2; }
  }
  if (cmd === 'reviews') {
    const at = (flag) => { const i = rest.indexOf(flag); return i < 0 ? null : Date.parse(rest[i + 1]); };
    const since = at('--since'); const until = at('--until');
    if (Number.isNaN(since) || Number.isNaN(until)) { out('bad --since or --until (an ISO date)'); return 2; }
    try { out(reviewSummaryLine(reviewStats({ since, until }))); return 0; } catch (e) { out(`reviews failed: ${e.message}`); return 2; }
  }
  if (cmd === 'status') {
    let limits = '';
    try { limits = `\n${reviewLimitsLine({ softRaw: opt('api_review_soft_usd', ''), hardRaw: opt('api_review_hard_usd', '') })}`; } catch { /* a bad limits setting never hides the ledger */ }
    const st = status({ now, cfg, env });
    const b = await billing();
    let share = '';
    try { share = `\n${reviewShareLines({ now }).join('\n')}`; } catch { /* the share never hides the ledger */ }
    out(st.text + limits + share + '\n' + billingStatusLines(b.ok ? b.snapshot : null, { cfg, entries: (st.ledger && st.ledger.entries) || [], now, reason: b.reason || '', cacheAgeMs: b.ok ? b.ageMs : null }).join('\n'));
    return 0;
  }
  if (cmd === 'summary') { out(summaryLine({ now, cfg })); return 0; }
  if (cmd === 'probe') {
    const r = await runApi({
      prompt: 'Reply with exactly one word: ok', model: 'haiku', tools: false, maxTokens: 512, category: 'review', meta: 'probe', cfg, now, env,
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
  out('usage: api-credits.mjs decide <category> | record <category> <usd> <meta> --api-key-source ANTHROPIC_API_KEY | record-fallback <review id> [--reason <r>] | reviews [--since <date>] [--until <date>] | status | summary | probe');
  return 2;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
  // A billing fetch that lost the deadline race must not keep the process (and the caller) waiting on its sockets.
  setTimeout(() => process.exit(), 100);
}
