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
import { loadConfig, resolveKey, record, recordFailure } from './api-credits.mjs';
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
//   { ok:true, text, usd, turns, tokens:{input,output,cacheRead,cacheWrite}, model, stopReason }
//   { ok:false, unavailable:true|false, reason, usd }
// Books the cost (and a billing/auth/config failure) in the ledger. Never throws.
export async function runApi({
  prompt, model, effort = null, cwd = process.cwd(), category = 'review', meta = '', system = null,
  tools = true, maxUsd = 8, maxTurns = 30, maxTokens = 16000, requestTimeoutMs = 5 * 60 * 1000,
  cfg = loadConfig(), env = process.env, now = Date.now(), fetchImpl = globalThis.fetch, endpoint = OFFICIAL_ENDPOINT,
  sleep = sleepMs, retries = 2,
}) {
  let key = '';
  let usd = 0;
  let turnCount = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const bookCost = (ok) => {
    if (usd > 0 || ok) {
      try {
        record(category, usd, `${meta} ${ok ? 'ok' : 'partial'}`.trim(), {
          cfg, now, success: ok, detail: { project: basename(resolve(cwd)), model: modelId, tokens: { ...tokens }, turns: turnCount },
        });
      } catch { /* ledger trouble does not change the answer */ }
    }
  };
  let modelId = String(model);
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
    const softCap = maxUsd * 0.8;
    let turns = 0;
    let last = null;

    for (;;) {
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
          res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(requestTimeoutMs) });
          raw = await res.text();
        } catch (e) {
          res = null; raw = String((e && e.message) || e);
        }
        const st = res ? res.status : 0;
        if ((st === 0 || st === 429 || st >= 500) && attempt < retries) { await sleep(1000 * 3 ** attempt); continue; }
        break;
      }
      const status = res ? res.status : 0;
      let j = null;
      try { j = JSON.parse(raw); } catch { /* not JSON */ }
      if (status !== 200 || !j || j.type === 'error') {
        const msg = scrub((j && j.error && j.error.message) || raw || 'no response', key).replace(/\s+/g, ' ').trim().slice(0, 200);
        if (isWorkspaceMissing({ status, text: msg })) {
          try { recordFailure(WORKSPACE_HINT, { cfg, now }); } catch { /* see above */ }
          bookCost(false);
          return { ok: false, unavailable: true, reason: WORKSPACE_HINT, usd };
        }
        if (isUnavailable({ status, text: msg }) || isSpendLimit({ status, text: msg })) {
          const reason = `HTTP ${status || '?'}: ${msg}`.slice(0, 200);
          try { recordFailure(reason, { cfg, now, hard: isSpendLimit({ status, text: msg }) }); } catch { /* see above */ }
          bookCost(false);
          return { ok: false, unavailable: true, reason, usd };
        }
        bookCost(false);
        return { ok: false, unavailable: false, reason: `HTTP ${status || '?'}: ${msg}`.slice(0, 200), usd };
      }

      turns += 1;
      turnCount = turns;
      const u = usageOf(j.usage);
      for (const k of Object.keys(tokens)) tokens[k] += u[k];
      const p = priceUsage(u, modelId);
      usd += p ? p.usd : 0;
      last = j;
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
        continue;
      }
      break;
    }

    const text = scrub(textOf(last.content), key);
    if (!text) {
      bookCost(false);
      return { ok: false, unavailable: false, reason: `the model returned no text (stop_reason ${last.stop_reason})`, usd };
    }
    bookCost(true);
    return { ok: true, text, usd, turns, tokens, model: modelId, stopReason: last.stop_reason };
  } catch (e) {
    bookCost(false);
    const reason = scrub(String((e && e.message) || e), key).slice(0, 200);
    if (e && e.configFailure) { try { recordFailure(reason, { cfg, now }); } catch { /* see above */ } }
    return { ok: false, unavailable: !!(e && e.configFailure), reason, usd };
  }
}
