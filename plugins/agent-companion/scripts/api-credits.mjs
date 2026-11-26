#!/usr/bin/env node
// api-credits.mjs — the API-credit governor (ledger: <state root>/state/api-credits.json).
//
//   node api-credits.mjs decide <category> [--peek] [--target <name>]  (--target: a named API target, with failover to the targets after it; a non-primary api answer adds a line "target: <name>")     (--peek: do not advance the review alternation counter) prints "api" or "plan", then one reason line (billed spend from the Admin API plus booked spend after the last complete day; "booked only, not verified against billing" without an admin key or network)
//   node api-credits.mjs record <category> <usd> <meta> --api-key-source ANTHROPIC_API_KEY [--target <name>]  appends spend; without the flag it is refused (exit 2, nothing booked, a line in api-credits-rejects.jsonl)
//   node api-credits.mjs status                         spend by category, the pace, what is left, the review limits in force, then billed spend (month and cycle, by workspace, key and model), the booked figure beside it, gaps, credits left (estimate), workspace limits
//   node api-credits.mjs credits [--json]               used this cycle (billed per workspace and model, booked not yet billed), remaining (Console balance anchor minus billed since), caps
//   node api-credits.mjs credits anchor <usd> [--date <ISO>]  records the Console balance and its date (agent-companion state); replaces the last anchor
//   node api-credits.mjs record-fallback <review id> [--reason <r>]  marks a review as redone on the plan (the id api-review.mjs printed)
//   node api-credits.mjs reviews [--since <ISO date>] [--until <ISO date>]  real reviews only (no probe or measure rows): count, spend, median, stopped or fallen back
//   node api-credits.mjs summary                        one line: "API credits: reviews $X of the review share of the budget, cycle day N"
//   node api-credits.mjs probe                         one tiny haiku Messages call on the key; reports tokens and dollar cost, books it
//
// Categories: review, overflow, rater, workers (API worker runs, scripts/api-worker.mjs). Any error, a missing key or an unreadable ledger
// answers "plan". `--now <ISO time>` is a test seam. Settings: api_credits_* plugin
// options (see README "API credits"). Exit codes: 0 ok, 2 bad usage, 1 probe failed.

import { isMain } from './lib/is-main.mjs';
import { CATEGORIES, TargetError, namedTargets, resolveTargets, targetLines, decide, record, recordFallback, reviewStats, reviewSummaryLine, reviewShareLines, status, summaryLine, billingStatusLines } from './lib/api-credits.mjs';
import { creditsView, creditsLines, readAnchor, writeAnchor } from './lib/api-credits.mjs';
import { runApi, reviewLimitsLine } from './lib/api-run.mjs';
import { getBilling, getTargetOrgs, loadSpendConfig } from './lib/api-spend.mjs';
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
  // --target <name>: the named API target (decide, record). Taken out of the arguments before the commands read them.
  let targetArg = null;
  { const ti = args.indexOf('--target'); if (ti >= 0) { targetArg = args[ti + 1] ?? ''; args.splice(ti, 2); } }
  if (targetArg !== null && (!String(targetArg).trim() || String(targetArg).startsWith('--'))) { out('--target needs a target name'); return 2; }
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
    if (targetArg !== null && CATEGORIES.includes(rest[0])) { try { resolveTargets(rest[0], cfg, targetArg); } catch (e) { if (e instanceof TargetError) { out(e.message); return 2; } throw e; } }
    const d = decide(rest[0], { now, cfg, env, billing: b.ok ? b.snapshot : null, peek, target: targetArg });
    out(d.decision); out(d.reason);
    if (d.target) out(`target: ${d.target}`);
    return 0;
  }
  if (!cfg) { out('unreadable configuration'); return 2; }
  if (cmd === 'record') {
    const ki = rest.indexOf('--api-key-source');
    const apiKeySource = ki >= 0 ? (rest[ki + 1] ?? '') : null;
    const rr = ki >= 0 ? rest.filter((_, i) => i !== ki && i !== ki + 1) : rest;
    if (!CATEGORIES.includes(rr[0]) || rr[1] === undefined) { out('usage: api-credits.mjs record <review|overflow|rater|workers> <usd> <meta> --api-key-source ANTHROPIC_API_KEY'); return 2; }
    const tgt = targetArg === null ? null : String(targetArg).toLowerCase();
    if (tgt !== null && !(cfg.targets || { primary: 1 })[tgt]) { out(`unknown target "${String(targetArg).slice(0, 40)}" (known: ${Object.keys(cfg.targets || { primary: 1 }).join(', ')})`); return 2; }
    try { const r = record(rr[0], rr[1], rr.slice(2).join(' '), { now, cfg, apiKeySource, target: tgt }); out(`recorded; ${rr[0]} total $${r.spent.toFixed(2)} in ${r.n} item(s)`); return 0; } catch (e) { out(`record failed: ${e.message}`); return 2; }
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
    const tl = await targetReport({ st, cfg, now, env, b, fetchImpl: billingFetch, readKey });
    out(st.text + limits + share + '\n' + billingStatusLines(b.ok ? b.snapshot : null, { cfg, entries: (st.ledger && st.ledger.entries) || [], now, reason: b.reason || '', cacheAgeMs: b.ok ? b.ageMs : null }).join('\n') + (tl.length ? `\n${tl.join('\n')}` : ''));
    return 0;
  }
  if (cmd === 'credits') return creditsCommand(rest, { out, now, cfg, env, billing, fetchImpl: billingFetch, readKey });
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
  out('usage: api-credits.mjs decide <category> | record <category> <usd> <meta> --api-key-source ANTHROPIC_API_KEY | record-fallback <review id> [--reason <r>] | reviews [--since <date>] [--until <date>] | status | credits [--json] | credits anchor <usd> [--date <ISO>] | summary | probe');
  return 2;
}

// Per-target lines for status and credits: empty when nothing about targets is configured (and then nothing is fetched). A failing
// admin key shows as "no cost data" for its org, never as an error.
async function targetReport({ st, cfg, now, env, b, fetchImpl, readKey }) {
  try {
    const named = namedTargets(cfg).length;
    if (!named && !(cfg.targetErrors || []).length && !Object.keys(cfg.categoryTargets || {}).length) return [];
    const orgs = named ? await getTargetOrgs({ now, cfg, env, primary: b, ...(fetchImpl ? { fetchImpl } : {}), ...(readKey ? { readKey } : {}) }) : [];
    return targetLines({ cfg, cycle: st && st.ledger ? st.ledger : undefined, orgs, now });
  } catch (e) { return [`API targets: report failed (${String((e && e.message) || e).slice(0, 80)})`]; }
}

// `credits [--json]` and `credits anchor <usd> [--date <ISO>]`. The view never fails: without an admin key, or when the Admin API
// call fails, it prints the ledger-only view with the reason in one line and exits 0. The anchor is the Console balance on a date
// (the Admin API cannot read the balance); it is stored in the agent-companion state.
async function creditsCommand(rest, { out, now, cfg, env, billing, fetchImpl, readKey }) {
  if (rest[0] === 'anchor') {
    const di = rest.indexOf('--date');
    const dateRaw = di >= 0 ? rest[di + 1] : null;
    const args = rest.slice(1).filter((_, i) => di < 0 || (i + 1 !== di && i + 1 !== di + 1));
    if (args.length !== 1 || (di >= 0 && !dateRaw)) { out('usage: api-credits.mjs credits anchor <usd> [--date <ISO date or time>]  (the balance the Console shows on that date)'); return 2; }
    const asOf = dateRaw === null ? now : (/^\d{4}-\d{2}-\d{2}/.test(dateRaw) ? Date.parse(dateRaw) : NaN);
    try {
      const prev = readAnchor();
      const a = writeAnchor(args[0], { asOf, now });
      out(`anchored: Console balance $${a.usd.toFixed(2)} as of ${new Date(a.asOf).toISOString()}${prev ? `; replaced $${prev.usd.toFixed(2)} as of ${new Date(prev.asOf).toISOString().slice(0, 10)}` : ''}`);
      return 0;
    } catch (e) { out(`anchor failed: ${e.message}`); return 2; }
  }
  const json = rest.includes('--json');
  let st = { text: 'ledger unreadable', ledger: {} };
  try { st = status({ now, cfg, env }); } catch { /* the view says the ledger is unreadable */ }
  const b = await billing();
  const view = creditsView({ snap: b.ok ? b.snapshot : null, reason: b.reason || '', cfg, ledgerCycle: st.ledger || {}, ledgerOk: !/ledger unreadable/.test(st.text), anchor: readAnchor(), now, fetchedAgeMs: b.ok ? b.ageMs : null });
  const tl = await targetReport({ st, cfg, now, env, b, fetchImpl, readKey });
  if (json) { if (tl.length) view.targets = tl; out(JSON.stringify(view, null, 2)); } else out(creditsLines(view).join('\n') + (tl.length ? `\n${tl.join('\n')}` : ''));
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
  // A billing fetch that lost the deadline race must not keep the process (and the caller) waiting on its sockets.
  setTimeout(() => process.exit(), 100);
}
