#!/usr/bin/env node
// api-worker.mjs — run a WRITER brief on the Agent SDK with the Console API key, so the work is billed to the plan's
// API credits (workers workspace) and not to the subscription. The plan's API credits cover the Claude API and the
// Agent SDK, NOT Claude Code, so this never runs `claude -p` (platform.claude.com api-credits-for-subscribers).
//
//   node api-worker.mjs run --brief-file <f> --cwd <worktree> [--model sonnet] [--max-usd 3] [--max-turns 60]
//                           [--workspace-id <id>] [--result-file <f>] [--meta <label>]
//
// stdout: the worker's final text, then one line `API-WORKER {json}` (status, cost_usd, turns, model, apiKeySource, reason).
// Exit: 0 done; 2 bad usage; 3 refused before any work (no key, no workspace id, Opus, budget, wrong auth source: nothing was
// spent); 4 the run stopped or failed (spend cap, turn cap, error): the worktree may hold partial work, read the text.
// Run it in the background (run_in_background) and wait for its notification: a foreground Bash call is cut at 10 minutes.
//
// Guarantees (docs checked 2026-11-15, https://code.claude.com/docs/en/agent-sdk/typescript and /env-vars):
//   - the child env is rebuilt from a small allow-list (sdkEnv in lib/api-sdk-run.mjs): the key goes in ANTHROPIC_API_KEY only, the
//     OAuth/auth-token variables are removed, CLAUDE_CONFIG_DIR is a private empty dir (no subscription login to fall back on);
//   - the workspace header goes in ANTHROPIC_CUSTOM_HEADERS ("anthropic-workspace-id: <id>"); with no id the run is refused;
//   - the init message must report apiKeySource "ANTHROPIC_API_KEY" or the run is aborted before any tool runs
//     (tools are also denied by the PreToolUse hook until the init was verified);
//   - api-credits.mjs decide workers (CLI) runs before the run and record workers <usd> after it;
//   - a PreToolUse hook denies shell commands that would print the environment or a secret (envDumpReason);
//   - the key is never printed, logged or written: every output is scrubbed of it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { spawnSyncHidden } from './lib/proc.mjs';
import { priceUsage } from './lib/pricing.mjs';
import { opt, stateFile, REVIEWER_SESSION_ENV } from '../hooks/lib/context.mjs';
import { loadConfig, resolveKey } from './lib/api-credits.mjs';
import { validKeyShape, scrub, resolveModel } from './lib/api-run.mjs';
import { envDumpHits } from '../hooks/lib/env-dump-guard.mjs';
import { loadSdk, sdkEnv, initProof, DEFAULT_SDK_VERSION, REQUIRED_KEY_SOURCE, SDK_READ_DENY } from './lib/api-sdk-run.mjs';

export const WORKSPACE_ENV = 'AC_API_WORKERS_WORKSPACE_ID';
export const CATEGORY = 'workers';
export const DEFAULT_MAX_USD = 3;
export const DEFAULT_MAX_TURNS = 60;
export const HUNG_MS = 15 * 60 * 1000;
export const EXIT = { done: 0, usage: 2, refused: 3, failed: 4 };
// Edit and Write are what a writer needs on top of the reviewer's reads; the shell is Bash (Git Bash on Windows; the SDK's PowerShell tool is off by default).
export const WORKER_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];
const WORKER_DISALLOWED = ['Task', 'Agent', 'Skill', 'TodoWrite', 'NotebookEdit', 'Read(/proc/**)'];
// Destructive git stays with the lead: scoped denials hold in every permission mode.
// Any `git push` (the lead pushes) and `git -C <dir> push|reset --hard` (the -C form dodges a plain prefix rule; gitDenyReason in the hook covers every option order).
export const WORKER_BASH_DENY = [
  ...['push', 'push --force', 'push -f', 'reset --hard', 'clean'].map((s) => `Bash(git ${s}:*)`),
  'Bash(git -C * push:*)', 'Bash(git -C * reset --hard:*)',
];
const GIT_OPTS = String.raw`(?:(?:-C|-c|--git-dir|--work-tree|--namespace)(?:\s+|=)\S+\s+|--?[\w-]+\s+)*`;
const GIT_PUSH = new RegExp(String.raw`(?:^|[;&|(\n\x60]|&&)\s*(?:(?:sudo|command|exec|time)\s+)*git\s+${GIT_OPTS}push\b`, 'i');
const GIT_RESET_HARD = new RegExp(String.raw`(?:^|[;&|(\n\x60])\s*(?:(?:sudo|command|exec|time)\s+)*git\s+${GIT_OPTS}reset\b[^;&|\n]*--hard\b`, 'i');
// null when the command is fine; else the reason. Backs the PreToolUse hook (permission rules alone miss option-order variants).
export function gitDenyReason(command) {
  const c = String(command ?? '');
  if (GIT_PUSH.test(c)) return 'git push stays with the lead';
  if (GIT_RESET_HARD.test(c)) return 'git reset --hard stays with the lead';
  return null;
}
const STRIP_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', REVIEWER_SESSION_ENV];

// --- the env-dump guard ----------------------------------------------------------------------

const SECRET = '(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)';
// $NAME / ${NAME} (bash, PowerShell), %NAME% (cmd): upper-case names only, so $key and $monkey stay usable.
const PLAIN_VAR = new RegExp(`(?:\\$\\{?|%)[A-Z0-9_]*${SECRET}[A-Z0-9_]*`);
// Forms that name the environment itself, any case (PowerShell and Windows names are case-insensitive).
const ENV_VAR = new RegExp(`(?:\\$\\{?env:|(?<![\\w$])env:[\\\\/]?|process\\.env\\.|process\\.env\\[\\s*['"]|os\\.environ(?:\\.get\\()?[\\[(]\\s*['"]|ENV\\[\\s*['"]|getenv\\(\\s*['"]|GetEnvironmentVariable\\(\\s*['"])[A-Za-z0-9_]*(?:${SECRET}|ANTHROPIC|OAUTH)`, 'i');
const ANTHROPIC_VAR = /(?:\$\{?|%)(?:ANTHROPIC|CLAUDE_CODE_OAUTH|AC_API)[A-Z0-9_]*/;
const DUMP_PATTERNS = [
  // PowerShell env-drive forms only (a cmdlet or alias, then env:), not words like "fix env: handling" or grep "env:".
  [/(?:^|[;&|(\n\x60]|-Command\s+['"])\s*(?:Get-ChildItem|Get-Item|Get-Content|gci|ls|dir|gi|gc|cat|type|Set-Location|cd)\s+(?:-\w+\s+)*['"]?env:/i, 'Get-ChildItem env: and similar read the whole environment'],
  [/\bGetEnvironmentVariables\b/i, 'GetEnvironmentVariables dumps the environment'],
  [/process\.env(?![.\[\w])/, 'process.env dumps the environment'],
  [/os\.environ(?!\.get\b|\s*\[)/, 'os.environ dumps the environment'],
  [/\/proc\/[^\s'"]*\/environ/, '/proc/.../environ is the environment'],
  [/\breg(?:\.exe)?\s+query\s+\S*\\Environment/i, 'the registry Environment key holds user variables'],
  [/\.credentials\.json|[\\/]\.ssh[\\/]|[\\/]\.aws[\\/]|\.npmrc\b|\.netrc\b|\.git-credentials\b|config[\\/]gh[\\/]hosts\.yml|\.claude[\\/]\.cred/i, 'credential files are off limits'],
];
const HEAD = String.raw`(?:^|[;&|(\n\x60]|-c\s+['"]|-Command\s+['"]|/c\s+['"]?)\s*(?:(?:sudo|command|builtin|exec|call|time|nohup)\s+|&\s*)*['"]?`;
const BARE_ENV = new RegExp(`${HEAD}(?:env|printenv)(?=['"]?\\s*(?:$|[;&|)\\x60\\n]|>|-\\w))`, 'i');
const PRINTENV = new RegExp(`${HEAD}printenv\\b`, 'i');
const BARE_BUILTIN = new RegExp(`${HEAD}(?:set|export|declare|typeset|compgen\\s+-[ev]|export\\s+-p|declare\\s+-[px]+)['"]?\\s*(?:$|[;&|)\\x60\\n>])`, 'i');

// null when the command is fine; else a short reason (shown to the model). A guard rail, not a sandbox.
// The plugin's own env-dump parser (hooks/lib/env-dump-guard.mjs, the one poll-guard uses) runs first; the patterns below add what a
// worker must never do on top of it (a secret-named variable in ANY command, credential files).
export function envDumpReason(command, shell = 'bash') {
  const c = String(command ?? '');
  if (!c.trim()) return null;
  const hit = envDumpHits(c, shell).env;
  if (hit) return `the command would print the environment (${String(hit).slice(0, 80)})`;
  for (const [re, why] of DUMP_PATTERNS) if (re.test(c)) return why;
  if (PRINTENV.test(c)) return 'printenv prints the environment';
  if (BARE_ENV.test(c)) {
    // `env FOO=1 cmd` runs a command and is fine; a bare `env` (or only flags) prints the environment.
    const m = c.match(new RegExp(`${HEAD}env((?:\\s+[^\\s;&|)\\x60]+)*)`, 'i'));
    const rest = m ? m[1].trim().split(/\s+/).filter((t) => t && !t.startsWith('-') && !/^\w+=/.test(t)) : [];
    if (!rest.length) return 'a bare env prints the environment';
  }
  if (BARE_BUILTIN.test(c)) return 'set, export, declare and typeset with no arguments print the environment';
  if (ENV_VAR.test(c) || PLAIN_VAR.test(c) || ANTHROPIC_VAR.test(c)) return 'the command reads a variable that may hold a key, token or secret';
  return null;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// PreToolUse hook callback: no tool runs before the init message proved the auth source; shells are checked for env dumps.
export function makeGuardHooks(state) {
  const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  const cb = async (input) => {
    if (!state.authOk) return deny('the run has not been verified to use the API key; no tool may run');
    const name = String((input && input.tool_name) || '');
    if (name === 'Read' || name === 'Grep' || name === 'Glob') {
      const ti = input.tool_input || {};
      const target = String(ti.file_path || ti.path || '').replace(/\\/g, '/');
      if (/(?:^|\/)proc\//.test(target)) { state.denied.push('/proc is off limits'); return deny('blocked: /proc is off limits (it holds the process environment)'); }
    }
    if (SHELL_TOOLS.has(name)) {
      const git = gitDenyReason(input.tool_input && input.tool_input.command);
      if (git) { state.denied.push(git); return deny(`blocked: ${git}. Commit only; the lead pushes.`); }
      const why = envDumpReason(input.tool_input && input.tool_input.command, name === 'PowerShell' ? 'powershell' : 'bash');
      if (why) { state.denied.push(why); return deny(`blocked: ${why}. Do not print the environment or any secret.`); }
    }
    return {};
  };
  return { PreToolUse: [{ matcher: '.*', hooks: [cb] }] };
}

// --- the budget, through the api-credits CLI only ------------------------------------------------

const CREDITS_CLI = join(dirname(fileURLToPath(import.meta.url)), 'api-credits.mjs');
export function cliCredits(env = process.env) {
  const call = (args) => {
    const r = spawnSyncHidden(process.execPath, [CREDITS_CLI, ...args], { env, encoding: 'utf8', timeout: 60000 });
    if (r.error) throw new Error(`api-credits failed: ${r.error.code || r.error.message}`);
    return String(r.stdout || '').trim().split(/\r?\n/);
  };
  return {
    decide: (category) => { const [decision, ...why] = call(['decide', category]); return { decision, reason: why.join(' ') }; },
    record: (category, usd, meta) => {
      const [first] = call(['record', category, String(usd), meta]);
      if (!/^recorded/.test(first || '')) throw new Error(String(first || 'no answer').slice(0, 80));
    },
  };
}

// --- environment and options -----------------------------------------------------------------

export function workerEnv({ key, workspace, base = process.env, configDir = '' }) {
  const e = sdkEnv({ key, workspace, base, configDir });
  for (const k of Object.keys(e)) if (STRIP_ENV.includes(k.toUpperCase())) delete e[k];
  return e;
}

export const workerSystem = (maxTurns) => [
  'You are a writer running on an API worker. The brief is your task: do it exactly, in your working directory (a git worktree), and nothing else.',
  `You have about ${Math.max(1, maxTurns - 3)} tool turns: commit your work (git add, git commit) before they run out. Do not push; the lead pushes.`,
  'Never print the environment or any secret (env, printenv, set, echoing a KEY, TOKEN or SECRET variable): those commands are blocked.',
  'Your final message is the report the lead reads: say what you did, the files changed, the commands you ran and their results, and anything you could not finish.',
].join(' ');

export function workerOptions({ cwd, modelId, key, workspace, base = process.env, configDir = '', maxUsd, maxTurns, abortController, hooks }) {
  const tools = [...WORKER_TOOLS];
  return {
    cwd, model: modelId, env: workerEnv({ key, workspace, base, configDir }),
    settingSources: ['project'], plugins: [], skills: [], mcpServers: {}, strictMcpConfig: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: workerSystem(maxTurns) },
    tools, allowedTools: [...tools], disallowedTools: [...WORKER_DISALLOWED, ...SDK_READ_DENY, ...WORKER_BASH_DENY],
    permissionMode: 'dontAsk', maxTurns, maxBudgetUsd: maxUsd, persistSession: false,
    settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }, // a project settings `env` block must not redirect the key
    ...(abortController ? { abortController } : {}), ...(hooks ? { hooks } : {}),
  };
}

// --- the run ----------------------------------------------------------------------------------

const usageOf = (u) => {
  const c = (u && u.cache_creation) || {};
  return { input: Number(u && u.input_tokens) || 0, output: Number(u && u.output_tokens) || 0, cacheRead: Number(u && u.cache_read_input_tokens) || 0, cacheWrite: Number(u && u.cache_creation_input_tokens) || 0, cacheWrite1h: Number(c.ephemeral_1h_input_tokens) || 0 };
};
const textOf = (m) => (m && Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim() : '');

// Never throws. Returns { status, ok, exit, text, usd, turns, model, apiKeySource, reason, booked, denied }.
// status: done | stopped_budget | stopped_turns | failed | refused_key | refused_workspace | refused_model | refused_budget | refused_auth
export async function runWorker({
  prompt, cwd = process.cwd(), model = 'sonnet', maxUsd = DEFAULT_MAX_USD, maxTurns = DEFAULT_MAX_TURNS, workspaceId = '', meta = 'worker',
  env = process.env, cfg = null, credits = null, sdk = null, load = loadSdk, sdkVersion = DEFAULT_SDK_VERSION,
  opusPolicy = null, hungMs = HUNG_MS, configDir = null,
}) {
  let key = '';
  const out = (status, extra = {}) => {
    const refused = status.startsWith('refused_');
    return {
      status, ok: status === 'done', exit: status === 'done' ? EXIT.done : refused ? EXIT.refused : EXIT.failed, usd: 0, turns: 0, model: String(model),
      apiKeySource: null, booked: false, denied: [], ...extra,
      reason: scrub(extra.reason || '', key).replace(/\s+/g, ' ').slice(0, 300), text: scrub(extra.text || '', key),
    };
  };
  try {
    // 1. Model: Opus does not write (opus_writer_policy).
    const policy = String(opusPolicy ?? opt('opus_writer_policy', 'sonnet')).toLowerCase();
    const m = resolveModel(model);
    // Allow-list: only sonnet and haiku write; Opus and anything else (a new family included) need opus_writer_policy allow.
    if (!/sonnet|haiku/i.test(m.id) && policy !== 'allow') return out('refused_model', { reason: `Opus plans, Sonnet writes (opus_writer_policy): an API worker runs on sonnet or haiku only, not ${m.id}; use sonnet` });
    if (!priceUsage({ input: 1 }, m.id)) return out('refused_model', { reason: `no price for model ${m.id} in config/model-pricing.json, so its cost cannot be metered` });
    // 2. Key.
    cfg = cfg || loadConfig();
    try { key = resolveKey(cfg.keySource, env); } catch (e) { return out('refused_key', { reason: `no API key: ${String((e && e.message) || e)}` }); }
    if (!validKeyShape(key)) return out('refused_key', { reason: 'the configured secret is not a Console API key (it must start sk-ant-; admin and OAuth tokens are refused)' });
    // 3. Workspace: without the header a personal key bills to no workspace.
    const ws = String(workspaceId || env[WORKSPACE_ENV] || opt('api_workers_workspace_id', '') || '').trim();
    if (!ws) return out('refused_workspace', { reason: `no workers workspace id: set ${WORKSPACE_ENV} (or the api_workers_workspace_id option, or --workspace-id). A personal key is not tied to a workspace, so the run would not be billed to the workers workspace` });
    if (!/^[A-Za-z0-9_.-]+$/.test(ws)) return out('refused_workspace', { reason: 'the workspace id is malformed (letters, digits, _ . - only)' });
    // 4. Budget, through the api-credits CLI.
    credits = credits || cliCredits(env);
    let d;
    try { d = credits.decide(CATEGORY); } catch (e) { d = { decision: 'plan', reason: `budget check failed: ${String((e && e.message) || e)}` }; }
    if (d.decision !== 'api') return out('refused_budget', { reason: `api-credits decide ${CATEGORY}: ${d.decision} (${d.reason})` });
    // 5. The SDK.
    try { sdk = sdk || await load({ version: sdkVersion }); } catch (e) { return out('refused_auth', { reason: `the Agent SDK is not available: ${String((e && e.message) || e)}`.slice(0, 200) }); }

    const state = { authOk: false, denied: [] };
    const ac = new AbortController();
    let abortReason = null;
    let wake = () => {};
    const aborted = new Promise((r) => { wake = r; });
    const abort = (why) => { if (!abortReason) { abortReason = why; ac.abort(); wake(); } };
    let hungTimer = null;
    const armHung = () => { clearTimeout(hungTimer); hungTimer = setTimeout(() => abort('hung'), Math.max(1, hungMs)); if (hungTimer.unref) hungTimer.unref(); };
    let cd = configDir;
    if (cd === null) { try { cd = stateFile(join('sdk', 'config-worker')); mkdirSync(cd, { recursive: true }); } catch { cd = ''; } }
    const options = workerOptions({ cwd, modelId: m.id, key, workspace: ws, base: env, configDir: cd, maxUsd, maxTurns, abortController: ac, hooks: makeGuardHooks(state) });

    const seen = new Map();
    let usd = 0; let turns = 0; let lastText = ''; let result = null; let apiKeySource = null; let authFailed = false;
    armHung();
    const q = sdk.query({ prompt, options });
    const it = q[Symbol.asyncIterator]();
    try {
      for (;;) {
        const nxt = it.next();
        nxt.catch(() => {});
        const step = await Promise.race([nxt, aborted.then(() => ({ done: true }))]);
        if (step.done) break;
        armHung();
        const msg = step.value;
        if (!msg || typeof msg !== 'object') continue;
        if (msg.type === 'system' && msg.subtype === 'init') {
          apiKeySource = initProof(msg).apiKeySource;
          if (apiKeySource !== REQUIRED_KEY_SOURCE) { authFailed = true; abort('auth'); break; } // before any tool runs
          state.authOk = true;
        } else if (msg.type === 'assistant' && msg.message) {
          const am = msg.message;
          const id = String(am.id || `anon-${seen.size}`);
          const u = usageOf(am.usage);
          const old = seen.get(id) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
          const dlt = {}; const nw = {};
          for (const k of Object.keys(old)) { dlt[k] = Math.max(0, u[k] - old[k]); nw[k] = Math.max(old[k], u[k]); }
          seen.set(id, nw);
          const p = priceUsage(dlt, m.id);
          usd += p ? p.usd : 0;
          turns = seen.size;
          const t = textOf(am);
          if (t) lastText = t;
        } else if (msg.type === 'result') { result = msg; break; }
      }
    } finally {
      clearTimeout(hungTimer);
      if (typeof it.return === 'function') {
        let t2;
        await Promise.race([Promise.resolve().then(() => it.return()).catch(() => {}), new Promise((r) => { t2 = setTimeout(r, 2000); if (t2.unref) t2.unref(); })]);
        clearTimeout(t2);
      }
    }
    const sdkUsd = result && Number.isFinite(Number(result.total_cost_usd)) ? Number(result.total_cost_usd) : 0;
    if (sdkUsd > usd) usd = sdkUsd;
    if (result && Number.isFinite(Number(result.num_turns))) turns = Number(result.num_turns);

    // Fail closed: no init message (apiKeySource still null) is as bad as a wrong source; nothing is booked.
    if (authFailed || apiKeySource !== REQUIRED_KEY_SOURCE) return out('refused_auth', { apiKeySource, denied: state.denied, reason: apiKeySource === null ? `no init message arrived, so the auth source (${REQUIRED_KEY_SOURCE}) was never verified: refused, nothing booked` : `the SDK run authenticates with "${apiKeySource}", not ${REQUIRED_KEY_SOURCE}: it would not be billed to the API credits; aborted before any tool ran` });

    // Book what was spent, whatever the outcome.
    let booked = false;
    let bookNote = '';
    if (usd > 0) {
      try { credits.record(CATEGORY, usd, `${meta} ${basename(resolve(cwd))}`.trim()); booked = true; } catch (e) { bookNote = ` (booking failed: ${String((e && e.message) || e).slice(0, 80)})`; }
    }
    const base = { usd, turns, apiKeySource, booked, denied: state.denied, model: m.id };
    if (abortReason === 'hung') return out('failed', { ...base, text: lastText, reason: `no message for ${Math.round(hungMs / 60000)} minutes; stopped${bookNote}` });
    if (!result) return out('failed', { ...base, text: lastText, reason: `the SDK run ended without a result${bookNote}` });
    const text = (result.subtype === 'success' && typeof result.result === 'string' && result.result.trim()) || lastText;
    if (result.subtype === 'success' && !result.is_error) return out('done', { ...base, text, reason: bookNote.trim() });
    const errs = Array.isArray(result.errors) ? result.errors.join('; ') : '';
    const status = result.subtype === 'error_max_budget_usd' ? 'stopped_budget' : result.subtype === 'error_max_turns' ? 'stopped_turns' : 'failed';
    return out(status, { ...base, text, reason: `${result.subtype}${errs ? `: ${errs}` : ''}${bookNote}` });
  } catch (e) {
    return out('failed', { reason: String((e && e.message) || e) });
  }
}

// --- CLI -----------------------------------------------------------------------------------------

export async function main(argv, { write = (s) => process.stdout.write(`${s}\n`), env = process.env, ...inject } = {}) {
  const [cmd, ...rest] = argv;
  const a = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) { write(`unexpected argument ${rest[i]}`); return EXIT.usage; }
    a[rest[i].slice(2)] = rest[++i];
  }
  const num = (v, d) => (v === undefined ? d : Number(v));
  const maxUsd = num(a['max-usd'], Number(opt('api_workers_max_usd', DEFAULT_MAX_USD)) || DEFAULT_MAX_USD);
  const maxTurns = num(a['max-turns'], DEFAULT_MAX_TURNS);
  if (cmd !== 'run' || !a['brief-file'] || !a.cwd || !(maxUsd > 0) || !(maxTurns > 0)) {
    write('usage: api-worker.mjs run --brief-file <f> --cwd <worktree> [--model sonnet] [--max-usd 3] [--max-turns 60] [--workspace-id <id>] [--result-file <f>] [--meta <label>]');
    return EXIT.usage;
  }
  let prompt;
  try { prompt = readFileSync(a['brief-file'], 'utf8'); } catch { write(`cannot read the brief file ${a['brief-file']}`); return EXIT.usage; }
  if (!prompt.trim()) { write('the brief file is empty'); return EXIT.usage; }
  const r = await runWorker({ prompt, cwd: resolve(a.cwd), model: a.model || 'sonnet', maxUsd, maxTurns, workspaceId: a['workspace-id'] || '', meta: a.meta || 'worker', env, ...inject });
  const summary = { status: r.status, cost_usd: Number(r.usd.toFixed(4)), turns: r.turns, model: r.model, apiKeySource: r.apiKeySource, booked: r.booked, denied_commands: r.denied.length, reason: r.reason || undefined };
  if (a['result-file']) { try { writeFileSync(a['result-file'], `${JSON.stringify({ ...summary, text: r.text }, null, 2)}\n`); } catch { /* the stdout copy stands */ } }
  if (r.text) write(r.text);
  write(`API-WORKER ${JSON.stringify(summary)}`);
  return r.exit;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
