// api-run.mjs — one review (or probe) run on the Console API key, through the Messages API.
// Shared by scripts/api-review.mjs (a review) and `api-credits.mjs probe`.
//
// Why the Messages API and never `claude -p` with the key: the plan's API credits cover the
// Claude API, Managed Agents, the Agent SDK and the Playground, and do NOT cover Claude Code
// (https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers). So this
// module calls the API directly with Node's built-in fetch (no dependencies) and runs a small
// read-only tool loop (src: scripts/lib/api-tools.mjs: read_file, grep, glob, confined to the
// repository under review). The reviewer cannot run commands, so it cannot run the tests.
//
// What the official docs say (checked 2026-11-01):
//   - Messages API, https://platform.claude.com/docs/en/api/messages : POST /v1/messages with
//     the headers x-api-key, anthropic-version: 2023-06-01 and content-type: application/json;
//     the response carries stop_reason and a usage object (input_tokens, output_tokens,
//     cache_creation_input_tokens, cache_read_input_tokens).
//   - Tool use, https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use :
//     a client tool is declared with name, description and input_schema; the model answers with
//     tool_use blocks (stop_reason "tool_use") and the next user turn returns tool_result
//     blocks with the matching tool_use_id; tool_choice {"type":"none"} forbids further calls.
//   - Effort, https://platform.claude.com/docs/en/build-with-claude/effort : output_config.effort
//     takes low, medium, high, xhigh or max; no beta header.
//   - Prompt caching, https://platform.claude.com/docs/en/build-with-claude/prompt-caching :
//     a cache_control {"type":"ephemeral"} marker on the last block of the newest message caches
//     the whole prefix, so each loop turn re-reads the earlier turns at the cache-read price.
//   - Workspaces: a key that is not scoped to a workspace gets HTTP 400 "must include the
//     anthropic-workspace-id header" (seen on a real key); the id (env AC_API_WORKSPACE_ID, not
//     a secret) is then sent in that header.
//
// Key handling is absolute: the key is read by resolveKey from the configured source, lives in
// one request-headers object and nowhere else, and is never printed, logged, written to a file
// or put on a command line or in a URL. Every string that leaves this module is scrubbed of it.
// The endpoint is fixed to the official host and does not follow ANTHROPIC_BASE_URL (nothing in
// this plugin reads that variable; Claude Code reads it itself), so the key never goes to a gateway.

import { basename, resolve } from 'node:path';
import { priceUsage } from './pricing.mjs';
import { modelTiers } from '../../hooks/lib/context.mjs';
import { loadConfig, resolveKey, record, recordFailure, recordSpend } from './api-credits.mjs';
import { makeTools } from './api-tools.mjs';

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_UNAVAILABLE = 3; // billing/auth/config failure: fall back to the plan reviewer at once
export const EXIT_FAILED = 4;      // anything else: also fall back
export const OFFICIAL_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
export const WORKSPACE_ENV = 'AC_API_WORKSPACE_ID';
export const WORKSPACE_HINT = `set ${WORKSPACE_ENV}: the key is not scoped to a workspace (HTTP 400, the request must include the anthropic-workspace-id header)`;

// A Console API key starts sk-ant- (today sk-ant-usr...; older keys sk-ant-api...). Admin keys
// and OAuth tokens are not API keys for this purpose.
export function validKeyShape(key) {
  return /^sk-ant-/.test(key) && !/^sk-ant-(?:admin|oat)/.test(key);
}

export function scrub(s, key) {
  const t = String(s ?? '');
  return key ? t.split(key).join('[key removed]') : t;
}

const UNAVAILABLE_RE = /credit balance|insufficient (?:credit|fund|balance)|billing|payment required|invalid (?:x-api-key|api key)|authentication[_ ]error|unauthori[sz]ed|forbidden|permission[_ ]error|usage policy|organization (?:has been )?disabled|api key.*(?:revoked|disabled|expired)/i;
const WORKSPACE_RE = /anthropic-workspace-id/i;

// A 400 that names the workspace header is a configuration failure, handled like auth.
export function isWorkspaceMissing({ status, text }) {
  return (status === undefined || status === null || Number(status) === 400) && WORKSPACE_RE.test(String(text || ''));
}

// The review workspace's monthly spend limit answers HTTP 400 invalid_request_error (the
// organization cap answers 429 rate_limit_error, which stays an ordinary backoff and retry).
// A hard wall: the breaker trips at once, so nothing retries against it for the rest of the cycle.
const SPEND_LIMIT_RE = /spend(?:ing)? limit|usage limit|workspace.{0,60}limit|specified .{0,40}limit|monthly limit/i;
export function isSpendLimit({ status, text }) {
  return Number(status) === 400 && SPEND_LIMIT_RE.test(String(text || ''));
}

export function isUnavailable({ status, text }) {
  if ([401, 402, 403].includes(Number(status))) return true;
  if (isWorkspaceMissing({ status, text })) return true;
  return UNAVAILABLE_RE.test(String(text || ''));
}

// Alias (haiku, sonnet, opus, fable) to model id through the plugin's tier table; a full id passes.
export function resolveModel(model) {
  const t = (modelTiers().tiers || {})[String(model).toLowerCase()];
  if (t && t.resolvesTo && t.resolvesTo.modelId) return { id: t.resolvesTo.modelId, effort: t.resolvesTo.effortSupport !== false };
  return { id: String(model), effort: true };
}

export const usageOf = (u) => ({
  input: (u && u.input_tokens) || 0, output: (u && u.output_tokens) || 0,
  cacheRead: (u && u.cache_read_input_tokens) || 0, cacheWrite: (u && u.cache_creation_input_tokens) || 0,
});

// A configuration failure is handled like a billing failure: it counts toward the two-strikes breaker.
const configError = (msg) => Object.assign(new Error(msg), { configFailure: true });

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export const REVIEW_SYSTEM = [
  'You are a code reviewer. The repository under review is the head of the diff you are given, and you have three read-only tools:',
  'read_file, grep and glob. You cannot run commands, tests or git, and you cannot edit anything; say plainly in your review which',
  'checks you could not run. Read the surrounding code, not only the diff, and try to refute the change. Stop calling tools and write the',
  'review as soon as you can support a verdict.',
].join(' ');

// Move the single cache breakpoint to the last block of the last message.
function markCache(messages) {
  for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b && b.cache_control) delete b.cache_control;
  const last = messages[messages.length - 1];
  const blocks = Array.isArray(last.content) ? last.content : null;
  if (blocks && blocks.length) blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
}

const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim() : '');

// Run one conversation on the API key. Returns
//   { ok:true, text, usd, turns, tokens:{input,output,cacheRead,cacheWrite}, model, stopReason, notes }
//   { ok:false, unavailable:true|false, reason, usd, notes }
// either with `ledgerError` set when a ledger write failed (the amount is then not in the ledger).
// Books each paid turn as it completes (a killed run still leaves its spend) and the run as one
// ledger entry at the end, failures included (usd 0, with an error field). requireVerdict makes a run
// that ends without a VERDICT line (or was cut off) a failure instead of a pass. Never throws.
//
// Limits (operator ruling 2026-11-01: soft limits, not hard stops; shared by both engines):
//   - slow: at SLOW_REVIEW_MS (8 minutes) one row goes to state/long-runs.jsonl and a note is kept;
//     the review continues.
//   - hung: a run with no new message or tool result for HUNG_MS (10 minutes) is stopped (falls back).
//     This is the only time limit.
//   - spend: a note at SOFT_USD ($0.20), and one backstop, `maxUsd` (DEFAULT_HARD_USD, $0.50; option
//     api_review_hard_usd; 0 disables it), that ends a runaway tool loop (fetch: at 80% of it the next turn is the final, no-tools one; sdk: an abort). A reply that is already a final answer is kept.
//   `notes` is the list of soft-limit strings; they go into the ledger entry (`notes`).
export const DEFAULT_MAX_TOKENS = 64000; // thinking counts toward max_tokens; the effort docs start Opus xhigh/max at 64k
export const SLOW_REVIEW_MS = 8 * 60 * 1000;
export const HUNG_MS = 10 * 60 * 1000;
// Operator ruling 2026-11-01: measured normal reviews cost $0.005-0.10, so 20 cents flags a review worth a look
// and 50 cents means a runaway tool loop.
export const SOFT_USD = 0.2;
export const DEFAULT_HARD_USD = 0.5;

// The hard backstop from an option value: a finite number >= 0 (0 disables it), else the default.
export function hardUsdFrom(raw, fallback = DEFAULT_HARD_USD) {
  if (raw === '' || raw === null || raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Soft-limit notes, worded once for both engines.
export const slowNote = (min) => `ran past ${min} minutes (logged to long-runs.jsonl); not stopped`;
export const softUsdNote = (softUsd) => `passed the $${Number(softUsd).toFixed(2)} soft spend limit; not stopped`;

// Append the slow-review row to state/long-runs.jsonl (the schema of hooks/lib/long-run.mjs). Written for both soft
// limits, 8 minutes and the soft spend limit; for the spend limit `notes` (what it passed) go into the description, which is
// what the scout's `long-runs.mjs` listing shows. Returns the row, or null when the log could not be written. Never throws.
export async function logSlowReview({ meta = '', turns = 0, startedAt = Date.now(), now = Date.now(), logRow = null, notes = [] } = {}) {
  try {
    const row = {
      ts: new Date(now).toISOString(), sessionId: null, agentId: `api-review-${process.pid}-${startedAt}`, agentType: 'api-review',
      steps: turns, startedAt: new Date(startedAt).toISOString(), durationMin: Math.round(((now - startedAt) / 60000) * 10) / 10,
      description: `${String(meta || 'review')}${notes.length ? ` [${notes.join('; ')}]` : ''}`.slice(0, 200), transcriptPath: null,
    };
    const log = logRow || (await import('../../hooks/lib/long-run.mjs')).logLongRun;
    log(row);
    return row;
  } catch { return null; }
}
const CUT_OFF = ['max_tokens', 'refusal', 'pause_turn'];
export const hasVerdict = (t) => /^[\s*#`>_-]*VERDICT:\s*(?:PASS|FIX)\b/m.test(String(t || ''));

export async function runApi({
  prompt, model, effort = null, cwd = process.cwd(), category = 'review', meta = '', system = null,
  tools = true, maxUsd = DEFAULT_HARD_USD, softUsd = SOFT_USD, maxTurns = 30, maxTokens = DEFAULT_MAX_TOKENS,
  hungMs = HUNG_MS, requestTimeoutMs = hungMs, slowMs = SLOW_REVIEW_MS, logRow = null, clock = Date.now, requireVerdict = false,
  cfg = loadConfig(), env = process.env, now = Date.now(), fetchImpl = globalThis.fetch, endpoint = OFFICIAL_ENDPOINT,
  sleep = sleepMs, retries = 2,
}) {
  let key = '';
  let usd = 0;
  let booked = 0; // spend already in the ledger, turn by turn
  let turnCount = 0;
  let ledgerError = null;
  const startedAt = clock();
  let lastProgress = startedAt; // the last response or tool result: the hung clock
  const notes = [];
  let slowLogged = false;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const ledgerFailed = (what, e) => { ledgerError ||= `ledger write failed; ${what} (${scrub(String((e && e.message) || e), key).replace(/\s+/g, ' ').slice(0, 80)})`; };
  let modelId = String(model);
  const bookCost = (ok, error = null) => {
    try {
      record(category, usd, `${meta} ${ok ? 'ok' : 'partial'}`.trim(), {
        cfg, now, success: ok, alreadyBooked: booked, count: usd > 0 || ok,
        detail: { project: basename(resolve(cwd)), model: modelId, tokens: { ...tokens }, turns: turnCount, path: 'fetch', error: ok ? null : error, notes },
      });
    } catch (e) { ledgerFailed(`$${(usd - booked).toFixed(4)} not recorded`, e); }
  };
  const noteFailure = (reason, hard = false) => {
    try { recordFailure(reason, { cfg, now, hard }); } catch (e) { ledgerFailed('the failure count was not recorded', e); }
  };
  const fail = (unavailable, reason) => {
    const r = scrub(reason, key).slice(0, 200);
    bookCost(false, r);
    return { ok: false, unavailable, reason: r, usd, path: 'fetch', notes, ...(ledgerError ? { ledgerError } : {}) };
  };
  try {
    key = resolveKey(cfg.keySource, env);
    if (!validKeyShape(key)) throw configError('the configured secret is not a Console API key (it must start sk-ant-, and sk-ant-admin and sk-ant-oat are refused)');
    const ws = String(env[WORKSPACE_ENV] || '').trim();
    if (ws && !/^[A-Za-z0-9_.-]+$/.test(ws)) throw configError(`${WORKSPACE_ENV} is malformed (letters, digits, _ . - only)`);
    const m = resolveModel(model);
    modelId = m.id;
    if (!priceUsage({ input: 1 }, modelId)) throw new Error(`no price for model ${modelId} in config/model-pricing.json, so its cost cannot be metered`);
    if (typeof fetchImpl !== 'function') throw new Error('no fetch available');
    const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION };
    if (ws) headers['anthropic-workspace-id'] = ws;
    const toolbox = tools ? makeTools(cwd) : null;
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    const softCap = maxUsd > 0 ? maxUsd * 0.8 : Infinity; // the backstop here: at 80% of it the next turn is the last, a no-tools turn that writes the review (no tool loop runs past it)
    const hungReason = () => `no response for ${Math.round((hungMs / 60000) * 10) / 10} minutes after ${turnCount} turn(s); falling back to the plan`;
    const hung = () => clock() - lastProgress >= hungMs;
    const checkSlow = async () => {
      if (slowLogged || clock() - startedAt < slowMs) return;
      slowLogged = true;
      notes.push(slowNote(Math.round(slowMs / 6000) / 10));
      await logSlowReview({ meta, turns: turnCount, startedAt, now: clock(), logRow });
    };
    let turns = 0;
    let last = null;

    for (;;) {
      await checkSlow();
      const final = !toolbox || turns >= maxTurns - 1 || usd >= softCap;
      if (final && toolbox && turns > 0) {
        const tail = messages[messages.length - 1];
        if (tail.role === 'user' && Array.isArray(tail.content)) tail.content.push({ type: 'text', text: 'Tool budget reached: make no more tool calls. Write the review now, starting with the VERDICT line.' });
      }
      markCache(messages);
      const body = { model: modelId, max_tokens: maxTokens, messages };
      if (system) body.system = system;
      if (toolbox) { body.tools = toolbox.definitions; if (final) body.tool_choice = { type: 'none' }; }
      if (effort && m.effort) body.output_config = { effort };

      let res = null;
      let raw = '';
      for (let attempt = 0; ; attempt++) {
        try {
          // redirect: 'error' so the key header can never follow a redirect off the official host.
          res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, hungMs - (clock() - lastProgress)))) });
          raw = await res.text();
        } catch (e) {
          res = null; raw = String((e && e.message) || e);
        }
        const st = res ? res.status : 0;
        if ((st === 0 || st === 429 || st >= 500) && attempt < retries && !hung()) { await sleep(1000 * 3 ** attempt); continue; }
        break;
      }
      if (!res && hung()) return fail(false, hungReason());
      const status = res ? res.status : 0;
      let j = null;
      try { j = JSON.parse(raw); } catch { /* not JSON */ }
      if (status !== 200 || !j || j.type === 'error') {
        const msg = scrub((j && j.error && j.error.message) || raw || 'no response', key).replace(/\s+/g, ' ').trim().slice(0, 200);
        if (isWorkspaceMissing({ status, text: msg })) {
          noteFailure(WORKSPACE_HINT);
          return fail(true, WORKSPACE_HINT);
        }
        if (isUnavailable({ status, text: msg }) || isSpendLimit({ status, text: msg })) {
          const reason = `HTTP ${status || '?'}: ${msg}`.slice(0, 200);
          noteFailure(reason, isSpendLimit({ status, text: msg }));
          return fail(true, reason);
        }
        return fail(false, `HTTP ${status || '?'}: ${msg}`);
      }

      turns += 1;
      turnCount = turns;
      lastProgress = clock();
      const u = usageOf(j.usage);
      for (const k of Object.keys(tokens)) tokens[k] += u[k];
      const p = priceUsage(u, modelId);
      usd += p ? p.usd : 0;
      // Book this paid turn now: a run that is killed or times out later still leaves its spend.
      if (p && p.usd > 0) { try { recordSpend(category, p.usd, { cfg, now }); booked += p.usd; } catch { /* the final record() books the rest and reports a failure */ } }
      last = j;
      if (usd >= softUsd && !notes.some((n) => n.startsWith('passed the $'))) {
        notes.push(softUsdNote(softUsd)); // also a long-runs row, so the scout lists the review (unless the slow row below already is one)
        await logSlowReview({ meta, turns: turnCount, startedAt, now: clock(), logRow, notes: [`${notes[notes.length - 1]}: $${usd.toFixed(2)} after ${turnCount} turn(s)`] });
      }
      const content = Array.isArray(j.content) ? j.content : [];
      const uses = content.filter((b) => b && b.type === 'tool_use');
      if (j.stop_reason === 'tool_use' && uses.length && toolbox && !final) {
        messages.push({ role: 'assistant', content });
        const results = uses.map((b) => {
          try { return { type: 'tool_result', tool_use_id: b.id, content: scrub(toolbox.run(b.name, b.input), key) }; } catch (e) {
            return { type: 'tool_result', tool_use_id: b.id, content: scrub(String((e && e.message) || e), key).slice(0, 300), is_error: true };
          }
        });
        messages.push({ role: 'user', content: results });
        lastProgress = clock();
        continue;
      }
      break;
    }

    const text = scrub(textOf(last.content), key);
    if (!text) return fail(false, `the model returned no text (stop_reason ${last.stop_reason})`);
    if (requireVerdict) {
      if (CUT_OFF.includes(last.stop_reason)) return fail(false, `the review was cut off (stop_reason ${last.stop_reason}); no usable verdict`);
      if (!hasVerdict(text)) return fail(false, `the review has no VERDICT line (stop_reason ${last.stop_reason})`);
    }
    await checkSlow();
    bookCost(true);
    return { ok: true, text, usd, turns, tokens, model: modelId, stopReason: last.stop_reason, path: 'fetch', notes, ...(ledgerError ? { ledgerError } : {}) };
  } catch (e) {
    const reason = scrub(String((e && e.message) || e), key).slice(0, 200);
    if (e && e.configFailure) noteFailure(reason);
    return fail(!!(e && e.configFailure), reason);
  }
}
