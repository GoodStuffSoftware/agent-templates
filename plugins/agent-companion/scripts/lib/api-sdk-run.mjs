// api-sdk-run.mjs — the second review engine: the Claude Agent SDK on the Console API key.
// Same interface and guarantees as scripts/lib/api-run.mjs (the fetch engine), plus the one thing
// the fetch engine cannot do: the reviewer loads the project's rules (CLAUDE.md), the project's hooks and this plugin,
// and has Read, Grep, Glob, WebSearch and WebFetch. A review is a READ of the code (operator rule 2026-11-08): there is
// no Bash or PowerShell tool, so the reviewer cannot build, run tests or CI, or rerun the writer's checks (before
// 0.31.49 it had both shells and ran the affected tests). Edit and Write (the runner writes the review file itself),
// Agent/Task, notebooks and MCP stay off.
//
// Why this is allowed on the credits: the plan's API credits cover the Claude API, Managed Agents,
// the Agent SDK and the Playground, and do NOT cover Claude Code
// (https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers). The SDK run is
// billed to the credits only while it authenticates with ANTHROPIC_API_KEY, so the init message's
// apiKeySource is checked and a run on anything else is aborted before it does any work.
//
// What the SDK docs say (https://code.claude.com/docs/en/agent-sdk/typescript, checked 2026-11-01
// and against the types of 0.3.316):
//   - settingSources: [] loads no user, project or local settings; plugins, skills and MCP servers
//     have their own options and default to none. 'project' loads the project's .claude/settings.json (hooks,
//     permissions, enabledPlugins) and, per sdk.d.ts, "must include 'project' to load CLAUDE.md files".
//   - plugins: [{ type: 'local', path }] loads one plugin directory (its hooks, skills, agents, commands and
//     .mcp.json); strictMcpConfig: true ignores every MCP source except the mcpServers option.
//   - systemPrompt takes a string; tools names the built-in tools that exist at all; allowedTools
//     auto-approves; disallowedTools removes tools; permissionMode "dontAsk" is requested, but the binary reports "default" while
//     CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 is set (measured 0.3.316): safety rests on the explicit allowedTools and disallowedTools lists, so nothing unlisted runs and nothing prompts.
//   - env REPLACES the subprocess environment. There is no apiKey or headers option: the key goes in
//     ANTHROPIC_API_KEY and the workspace header in ANTHROPIC_CUSTOM_HEADERS ("Name: Value").
//   - assistant messages carry the API usage; the result carries total_cost_usd and modelUsage.
//   - the package bundles the native binary as a platform optional dependency.
// The SDK's own spawn of the binary already sets windowsHide; our npm install goes through proc.mjs.
//
// What the reviewer loads (operator ruling 2026-11-01: an API reviewer gets the project rules and our guards):
//   - the PROJECT's settings (settingSources ['project']): its CLAUDE.md, .claude/settings.json and project hooks;
//   - this plugin, agent-companion, from the directory this very file lives in (the copy that runs api-review.mjs),
//     so its guards are the same version as the lead's;
//   - nothing else: no user settings (never in settingSources, and CLAUDE_CONFIG_DIR is a private empty dir), no other
//     plugin (a project that enables others finds none installed in that dir), skills: [], strictMcpConfig with no
//     servers (the project's .mcp.json is ignored). The tool lists below win over any project permission.
//   - plus the operator's user-level PreToolUse COMMAND hooks, and only those, as programmatic SDK hooks (the `hooks` option; scripts/lib/api-sdk-guards.mjs):
//     the user's guards (e.g. a destructive-git or secret guard) run in reviewer sessions without any user settings, plugin, MCP server or skill being loaded.
//     Option api_review_user_guards (default on) turns this off; plugin-own hooks are not wrapped (already loaded).
//   The init message is the proof; runApiSdk returns it as `init` and aborts the run when it lists a plugin other than ours or an MCP server.
//   The hooks know they run under a reviewer through REVIEWER_SESSION_ENV in the child env (hooks/lib/context.mjs): the lead-only hooks
//   exit silently, the safety guards run.
//
// The key reaches only the child's ANTHROPIC_API_KEY. CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 strips it
// from the Bash tool's environment, and every string leaving this module is scrubbed of it anyway.
// Unlike the fetch engine, this one is NOT confined to the repository: Read, Grep and Glob can read
// anywhere the operator's account can, and WebFetch reaches the network. The deny rules below block the obvious damage
// (writes through the file tools, credential directories), not a determined model; run it on trusted diffs.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { priceUsage } from './pricing.mjs';
import { stateFile, REVIEWER_SESSION_ENV } from '../../hooks/lib/context.mjs';
import { withFileLock } from '../../hooks/lib/file-lock.mjs';
import { loadConfig, resolveKey, record, recordFailure, recordSpend } from './api-credits.mjs';
import { spawnSyncHidden } from './proc.mjs';
import { buildUserGuards } from './api-sdk-guards.mjs';
import {
  validKeyShape, scrub, resolveModel, isUnavailable, isSpendLimit, isWorkspaceMissing, hasVerdict, WORKSPACE_ENV, WORKSPACE_HINT,
  SLOW_REVIEW_MS, HUNG_MS, SOFT_USD, DEFAULT_HARD_USD, slowNote, softUsdNote, logSlowReview,
} from './api-run.mjs';

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
export const DEFAULT_SDK_VERSION = '0.3.319';
export const REQUIRED_KEY_SOURCE = 'ANTHROPIC_API_KEY';

export const SDK_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
// Same on every platform: no Bash and no PowerShell (a review reads; it runs nothing). The platform argument is kept for the callers.
export const sdkToolsFor = (_platform = process.platform) => [...SDK_TOOLS];
// Removed from the model's context outright (bare names). Edit and Write are not in `tools` either;
// the explicit list is belt and braces against a future default.
export const SDK_DISALLOWED = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Task', 'Agent', 'Skill', 'TodoWrite'];
// Scoped denials: they hold in every permission mode. A guard rail, not a sandbox: the file tools run with the
// operator's own file access, so the credential directories are denied to them by name and the claude binary is
// pointed at a private config dir (CLAUDE_CONFIG_DIR).
export const SDK_READ_DENY = ['Read(~/.claude/**)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.config/**)', 'Read(~/.npmrc)'];
// Belt and braces: Bash is not in `tools`, so these only matter if a future default adds it back.
export const SDK_BASH_DENY = [
  'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(git clean:*)',
  'Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(rm:*)', 'Bash(del:*)', 'Bash(rmdir:*)', 'Bash(curl:*)', 'Bash(wget:*)',
];
export const SDK_SYSTEM_PREFIX = [
  'You are an adversarial code reviewer, and a review is a READ of the code: assume the change is wrong and hunt for what the writer missed. The repository under review is your working directory, checked out at the head of the diff you are given.',
  'Tools: Read, Grep, Glob, WebSearch and WebFetch. There is no shell: you do not build, run tests or CI, launch anything or rerun the writer\'s checks (the writer and CI run those). The instruction may allow targeted tests that need no build; this tool allowance cannot scope a test command safely, so you run none and name the targeted tests you would have run. Read the diff, the code it touches, and its callers and consumers (grep, trace the call path), and read the raw test and build output the writer put in the brief; say so if that output is missing.',
  'Find the repository\'s recorded decisions and standards with Glob and Read (ADR files such as docs/adr/, docs/decisions/ or ADR-*.md, any conventions or contributing doc; the project CLAUDE.md is loaded) and check the change against them and against the patterns of neighbouring code (naming, error handling, file layout, how similar features are done): a deviation is a finding unless the change also updates or adds the ADR that justifies it; if the repo has no ADRs, say so and check against the patterns alone.',
  'Use WebSearch and WebFetch only to check a library, API or tool the change relies on, never to send out repository content.',
  'Never modify the repository and do not fix anything. Read the surrounding code, not only the diff, and try to refute the change by reading. Your reply is a report to the main agent that asked for the review of what it missed: defects, gaps against the acceptance criteria, callers and consumers left unhandled, deviations from the ADRs and patterns.',
  'The project rules (its CLAUDE.md) are loaded: follow its conventions and prohibitions. Rules that address a lead or a writer (delegate, spawn agents, load skills, run a knowledge check, ask the user) do not apply to you: you are the reviewer, you do no knowledge check, and your reply is the review.',
  'Write the review as soon as you can support a verdict. Start it with one line, `VERDICT: PASS` or `VERDICT: FIX`, then list each finding as blocker, should-fix or nit with file:line and the reading that shows it (the call path, or the line that contradicts the change).',
].join(' ');

export function sdkSystem(maxTurns) {
  return `${SDK_SYSTEM_PREFIX} You have a budget of ${Math.max(1, maxTurns - 2)} tool turns: write the review before it runs out, because a review that is cut off counts as no review.`;
}

// --- environment -----------------------------------------------------------------------------

// The system variables a child needs to find and start its shell and tools. Matched case-insensitively
// (Windows). Everything not listed is dropped, which strips every Anthropic, Claude, cloud and CI
// credential in one stroke; the keys named below are then added on purpose.
const ENV_ALLOW = new Set([
  'path', 'pathext', 'systemroot', 'systemdrive', 'windir', 'comspec', 'os', 'userprofile', 'username', 'userdomain',
  'homedrive', 'homepath', 'home', 'appdata', 'localappdata', 'programdata', 'programfiles', 'programfiles(x86)', 'programw6432',
  'commonprogramfiles', 'commonprogramfiles(x86)', 'commonprogramw6432', 'temp', 'tmp', 'tmpdir', 'processor_architecture',
  'number_of_processors', 'computername', 'shell', 'user', 'logname', 'lang', 'lc_all', 'term', 'tz',
  'claude_code_git_bash_path', // where Claude Code finds Git Bash on Windows; a path, not a credential
]);

// Variables that keep the run small and quiet. All were found in the 0.3.316 binary.
const TRIM_ENV = {
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
};

export function sdkEnv({ key, workspace = '', base = process.env, configDir = '' }) {
  const out = {};
  for (const k of Object.keys(base)) if (ENV_ALLOW.has(k.toLowerCase()) && typeof base[k] === 'string') out[k] = base[k];
  Object.assign(out, TRIM_ENV);
  out[REVIEWER_SESSION_ENV] = '1'; // the hooks' marker: lead-only hooks stay silent, safety guards run (hooks/lib/context.mjs)
  out.ANTHROPIC_API_KEY = key;
  if (configDir) out.CLAUDE_CONFIG_DIR = configDir;
  if (workspace) out.ANTHROPIC_CUSTOM_HEADERS = `anthropic-workspace-id: ${workspace}`;
  return out;
}

// --- what the reviewer loads ---------------------------------------------------------------------

// The plugin copy this file belongs to (scripts/lib/ -> the plugin root): the reviewer gets the same version as the
// lead that started it. Empty when the layout is not a plugin (then no plugin is loaded and the run says so).
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function pluginIdentity(root = PLUGIN_ROOT) {
  try {
    const j = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    return j && typeof j.name === 'string' && j.name ? { name: j.name, version: String(j.version || ''), root } : null;
  } catch { return null; }
}

// The SDK query() options for one review. Exported so the tests and the init-message proof use the exact set a review uses.
export function sdkOptions({
  cwd, modelId, effortOption = null, key, workspace = '', base = process.env, configDir = '', platform = process.platform,
  system, maxTurns = 30, maxUsd = 0, abortController, pluginRoot = PLUGIN_ROOT, hooks = null,
}) {
  const tools = sdkToolsFor(platform);
  const plugin = pluginIdentity(pluginRoot);
  return {
    cwd, model: modelId, env: sdkEnv({ key, workspace, base, configDir }),
    // Project rules and project hooks, plus ONLY this plugin; no user settings, no skills, no MCP servers (project .mcp.json included).
    settingSources: ['project'], plugins: plugin ? [{ type: 'local', path: plugin.root }] : [], skills: [], mcpServers: {}, strictMcpConfig: true,
    systemPrompt: system || sdkSystem(maxTurns),
    // allowedTools and disallowedTools are command-line rules: a project's permissions.allow cannot widen them (deny wins).
    tools, allowedTools: [...tools], disallowedTools: [...SDK_DISALLOWED, ...SDK_READ_DENY, ...SDK_BASH_DENY],
    permissionMode: 'dontAsk', maxTurns, persistSession: false,
    // The spend backstop (maxUsd) is the runner's own check between messages, which keeps a final reply that ends the turn. It is NOT passed as the SDK's
    // maxBudgetUsd: the SDK enforces that after the final reply too and then reports an error, discarding a review that was already paid for.
    // The API host is pinned: a project .claude/settings.json `env` block must not be able to send the review key elsewhere (flag settings beat project settings).
    settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }, ...(abortController ? { abortController } : {}),
    // The user's own PreToolUse command hooks as programmatic SDK hooks (scripts/lib/api-sdk-guards.mjs): guards only, no user settings loaded.
    ...(hooks ? { hooks } : {}),
    ...(effortOption ? { effort: effortOption } : {}), // the routed effort: the SDK passes it to the binary as --effort
  };
}

// The init message, reduced to what proves what the session loaded. Carries names and paths only, never the key.
export function initProof(msg) {
  const names = (a) => (Array.isArray(a) ? a.map((x) => (x && typeof x === 'object' ? String(x.name ?? x) : String(x))) : []);
  return {
    apiKeySource: msg.apiKeySource ?? null, claudeCodeVersion: msg.claude_code_version ?? null, model: msg.model ?? null, permissionMode: msg.permissionMode ?? null,
    plugins: Array.isArray(msg.plugins) ? msg.plugins.map((p) => ({ name: String(p.name), version: p.version ?? null, source: p.source == null ? null : String(p.source) })) : [],
    pluginErrors: Array.isArray(msg.plugin_errors) ? msg.plugin_errors.map((e) => `${e.plugin}: ${e.type}`) : [],
    mcpServers: Array.isArray(msg.mcp_servers) ? msg.mcp_servers.map((m) => `${m.name}:${m.status}${m.source ? `:${m.source}` : ''}`) : [],
    tools: names(msg.tools), skills: names(msg.skills), slashCommands: names(msg.slash_commands).length, agents: names(msg.agents),
  };
}
// null when the init shows what a review is meant to load; else why not. Checked before the first API call.
// The binary's own built-in plugins (names cc-plugin-*, no version: agents-md, plugin-authoring as of 0.3.316; privacy joined in 0.3.319, no tool or skill) are loaded in every
// session, plugin-less and settings-less ones too (measured), and cannot be switched off from the options: they are not counted.
// Exactly these three, and (when the init reports a source) only from the binary itself (`<name>@builtin`).
export const BUILTIN_PLUGINS = Object.freeze(['cc-plugin-agents-md', 'cc-plugin-plugin-authoring', 'cc-plugin-privacy']);
export const isBuiltinPlugin = (p) => !!p && BUILTIN_PLUGINS.includes(String(p.name)) && !p.version && (p.source == null || String(p.source) === `${p.name}@builtin`);
// This plugin as the run loads it: by name, and (when the init reports a source) as an inline plugin from the path given to the options.
export const isOwnPlugin = (p, identity) => !!identity && !!p && p.name === identity.name && (p.source == null || /@inline$/.test(String(p.source)));
export function initMismatch(proof, identity = pluginIdentity()) {
  const extra = proof.plugins.filter((p) => !isBuiltinPlugin(p) && !isOwnPlugin(p, identity)).map((p) => (p.source ? `${p.name} (${p.source})` : p.name));
  if (extra.length) return `the SDK session loaded a plugin other than ${identity ? identity.name : 'none'} (${extra.join(', ')})`;
  if (proof.mcpServers.length) return `the SDK session connected MCP servers (${proof.mcpServers.join(', ')}); a review loads none`;
  return null;
}

// --- install on demand -------------------------------------------------------------------------

export const sdkDir = (version) => stateFile(join('sdk', version));
// A private, empty Claude config dir for the child: no user credentials, settings or sessions are read or written.
const configDirOf = (version) => { try { const d = stateFile(join('sdk', `config-${version}`)); mkdirSync(d, { recursive: true }); return d; } catch { return ''; } };
const entryOf = (dir) => join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

function installedVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version; } catch { return null; }
}

// npm through the hidden wrapper. On Windows npm is npm.cmd and needs a shell; the version is
// validated against VERSION_RE first, so nothing the caller passes reaches the shell unchecked.
export function npmInstall(dir, version) {
  const r = spawnSyncHidden('npm', ['install', `${SDK_PACKAGE}@${version}`, '--save-exact', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir, encoding: 'utf8', timeout: 5 * 60 * 1000, shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(`npm install failed (${r.error ? r.error.code || r.error.message : `exit ${r.status}`}): ${String(r.stderr || '').replace(/\s+/g, ' ').slice(0, 160)}`);
}

// Returns the SDK module, installing it first when the pinned version is not there. Throws on failure.
export async function loadSdk({ version = DEFAULT_SDK_VERSION, dir = sdkDir(version), install = npmInstall, importer = (url) => import(url) } = {}) {
  if (!VERSION_RE.test(String(version))) throw new Error(`api_sdk_version "${version}" is not a plain version number`);
  if (installedVersion(dir) !== version) {
    mkdirSync(dir, { recursive: true });
    withFileLock(`${dir}.lock`, () => {
      if (installedVersion(dir) === version) return; // another process finished it while we waited
      const pj = join(dir, 'package.json');
      if (!existsSync(pj)) writeFileSync(pj, `${JSON.stringify({ name: 'agent-companion-sdk', private: true, version: '0.0.0' })}\n`);
      install(dir, version);
    }, { failOpen: false, waitMs: 6 * 60 * 1000, staleMs: 6 * 60 * 1000 });
    if (installedVersion(dir) !== version) throw new Error(`the installed ${SDK_PACKAGE} is not ${version}`);
  }
  const mod = await importer(pathToFileURL(entryOf(dir)).href);
  if (!mod || typeof mod.query !== 'function') throw new Error(`${SDK_PACKAGE} has no query()`);
  return mod;
}

// --- the run -----------------------------------------------------------------------------------

const configError = (msg) => Object.assign(new Error(msg), { configFailure: true });
const AUTH_ERRORS = new Set(['authentication_failed', 'billing_error', 'account_on_hold', 'oauth_org_not_allowed', 'verification_required']);

const textOfMessage = (m) => (m && Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim() : '');

function usageFromApi(u) {
  const c = (u && u.cache_creation) || {};
  return {
    input: Number(u && u.input_tokens) || 0, output: Number(u && u.output_tokens) || 0,
    cacheRead: Number(u && u.cache_read_input_tokens) || 0, cacheWrite: Number(u && u.cache_creation_input_tokens) || 0,
    cacheWrite1h: Number(c.ephemeral_1h_input_tokens) || 0,
  };
}

// Same result shape and limits as runApi (soft: a note at 8 minutes and at softUsd, $1.00; stops only a hung run, no message
// for 10 minutes, and at the spend backstop maxUsd, 0 = none), plus `path: 'sdk'`. `sdkUnavailable: true` means the SDK could not be
// installed or imported before anything was spent: the caller falls back to the fetch engine.
// Never throws.
export async function runApiSdk({
  prompt, model, effort = null, cwd = process.cwd(), category = 'review', meta = '', system = null,
  maxUsd = DEFAULT_HARD_USD, softUsd = SOFT_USD, maxTurns = 30, requireVerdict = false, reviewId = null,
  hungMs = HUNG_MS, slowMs = SLOW_REVIEW_MS, logRow = null, sdkVersion = DEFAULT_SDK_VERSION, platform = process.platform,
  cfg = loadConfig(), env = process.env, now = Date.now(),
  sdk = null, load = loadSdk, userGuards = true, userConfigDir = null,
}) {
  let key = '';
  let usd = 0;
  let booked = 0;
  let turnCount = 0;
  let ledgerError = null;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const notes = [];
  const startedAt = Date.now();
  const ledgerFailed = (what, e) => { ledgerError ||= `ledger write failed; ${what} (${scrub(String((e && e.message) || e), key).replace(/\s+/g, ' ').slice(0, 80)})`; };
  let modelId = String(model);
  const bookCost = (ok, error = null) => {
    try {
      record(category, usd, `${meta} ${ok ? 'ok' : 'partial'}`.trim(), {
        cfg, now, success: ok, alreadyBooked: booked, count: usd > 0 || ok, id: reviewId,
        detail: { project: basename(resolve(cwd)), model: modelId, tokens: { ...tokens }, turns: turnCount, path: 'sdk', error: ok ? null : error, notes },
      });
    } catch (e) { ledgerFailed(`$${(usd - booked).toFixed(4)} not recorded`, e); }
  };
  const noteFailure = (reason, hard = false) => {
    try { recordFailure(reason, { cfg, now, hard }); } catch (e) { ledgerFailed('the failure count was not recorded', e); }
  };
  const fail = (unavailable, reason) => {
    const r = scrub(reason, key).slice(0, 200);
    bookCost(false, r);
    return { ok: false, unavailable, reason: r, usd, path: 'sdk', notes, ...(ledgerError ? { ledgerError } : {}) };
  };
  const hungReason = () => `no new message or tool result for ${Math.round((hungMs / 60000) * 10) / 10} minutes after ${turnCount} turn(s); falling back to the plan`;
  const capReason = () => `the review reached its spend backstop of $${Number(maxUsd).toFixed(2)} after ${turnCount} turn(s) without a verdict; falling back to the plan`;

  const ac = new AbortController();
  let abortReason = null;
  let wake = () => {};
  const aborted = new Promise((resolve) => { wake = resolve; }); // lets the loop stop even when the SDK ignores the abort
  const abort = (r) => { if (!abortReason) { abortReason = r; ac.abort(); wake(); } };
  let hungTimer = null;
  let slowTimer = null;
  const armHung = () => { // re-armed by every message: only silence stops the run
    clearTimeout(hungTimer);
    hungTimer = setTimeout(() => abort('hung'), Math.max(1, hungMs));
    if (hungTimer.unref) hungTimer.unref();
  };
  const stopTimers = () => { clearTimeout(hungTimer); clearTimeout(slowTimer); };
  try {
    key = resolveKey(cfg.keySource, env);
    if (!validKeyShape(key)) throw configError('the configured secret is not a Console API key (it must start sk-ant-, and sk-ant-admin and sk-ant-oat are refused)');
    const ws = String(env[WORKSPACE_ENV] || '').trim();
    if (ws && !/^[A-Za-z0-9_.-]+$/.test(ws)) throw configError(`${WORKSPACE_ENV} is malformed (letters, digits, _ . - only)`);
    const m = resolveModel(model);
    modelId = m.id;
    if (!priceUsage({ input: 1 }, modelId)) throw new Error(`no price for model ${modelId} in config/model-pricing.json, so its cost cannot be metered`);

    // Install / import. A failure here spends nothing: report it so the caller can use the fetch engine.
    try { sdk = sdk || await load({ version: sdkVersion }); } catch (e) {
      return { ok: false, unavailable: false, sdkUnavailable: true, reason: scrub(`the Agent SDK is not available: ${String((e && e.message) || e)}`, key).slice(0, 200), usd: 0, path: 'sdk' };
    }

    const options = sdkOptions({
      cwd, modelId, effortOption: effort && m.effort ? effort : null, key, workspace: ws, base: env, configDir: configDirOf(sdkVersion), platform,
      system, maxTurns, maxUsd, abortController: ac,
    });
    // The operator's user-level PreToolUse command hooks, wrapped as SDK hook callbacks (option api_review_user_guards, default on).
    let guards = null;
    if (userGuards) {
      try {
        const g = buildUserGuards({ configDir: userConfigDir || undefined, env, childEnv: options.env, cwd, pluginRoot: PLUGIN_ROOT, key, reviewerEnvName: REVIEWER_SESSION_ENV });
        guards = g.summary;
        if (g.hooks) options.hooks = g.hooks;
      } catch { guards = null; } // a guard problem never stops the review
    }
    armHung();
    slowTimer = setTimeout(() => { // soft: one long-runs row and a note, the review goes on
      notes.push(slowNote(Math.round(slowMs / 6000) / 10));
      logSlowReview({ meta, turns: turnCount, startedAt, now: Date.now(), logRow }).catch(() => {});
    }, Math.max(1, slowMs));
    if (slowTimer.unref) slowTimer.unref();

    const seen = new Map(); // assistant message id -> usage already counted (one API call can arrive as several messages)
    let lastText = '';
    let lastAssistantError = null;
    let lastStop = null;
    let result = null;
    let inited = false;
    let init = null;
    const book = (delta) => {
      if (delta > 0) { try { recordSpend(category, delta, { cfg, now }); booked += delta; } catch { /* the final record() books the rest */ } }
    };

    const q = sdk.query({ prompt, options });
    const it = q[Symbol.asyncIterator]();
    try {
      for (;;) {
        const nxt = it.next();
        nxt.catch(() => {}); // a late rejection after an abort is not an unhandled one
        const step = await Promise.race([nxt, aborted.then(() => ({ done: true }))]);
        if (step.done) break;
        armHung();
        const msg = step.value;
        if (!msg || typeof msg !== 'object') continue;
        if (msg.type === 'system' && msg.subtype === 'init') {
          inited = true;
          init = initProof(msg);
          if (msg.apiKeySource === REQUIRED_KEY_SOURCE) {
            const bad = initMismatch(init);
            if (bad) { abort('init-mismatch'); throw configError(bad); }
          }
          if (msg.apiKeySource !== REQUIRED_KEY_SOURCE) {
            abort('auth-source');
            throw configError(`the SDK run authenticates with "${msg.apiKeySource}", not ${REQUIRED_KEY_SOURCE}: it would not be billed to the API credits`);
          }
        } else if (msg.type === 'assistant' && msg.message) {
          const am = msg.message;
          const id = String(am.id || `anon-${seen.size}`);
          const u = usageFromApi(am.usage);
          const old = seen.get(id) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
          const d = {};
          const nw = {};
          for (const k of Object.keys(old)) { d[k] = Math.max(0, u[k] - old[k]); nw[k] = Math.max(old[k], u[k]); }
          seen.set(id, nw);
          for (const k of Object.keys(tokens)) tokens[k] += d[k];
          const p = priceUsage(d, modelId);
          const add = p ? p.usd : 0;
          usd += add;
          turnCount = seen.size;
          book(add);
          const t = textOfMessage(am);
          if (t) lastText = t;
          if (am.stop_reason) lastStop = am.stop_reason;
          if (msg.error) lastAssistantError = String(msg.error);
          if (usd >= softUsd && !notes.some((n) => n.startsWith('passed the $'))) {
            notes.push(softUsdNote(softUsd)); // also a long-runs row, so the scout lists the review
            logSlowReview({ meta, turns: turnCount, startedAt, now: Date.now(), logRow, notes: [`${notes[notes.length - 1]}: $${usd.toFixed(2)} after ${turnCount} turn(s)`] }).catch(() => {});
          }
          // The backstop is checked between messages (one expensive turn can overshoot it by its own cost);
          // a reply that already ends the turn is the review, so it is kept.
          if (maxUsd > 0 && usd >= maxUsd && am.stop_reason !== 'end_turn') { abort('spend-cap'); break; }
        } else if (msg.type === 'result') {
          result = msg;
          break;
        }
      }
    } finally {
      stopTimers();
      // Close the stream, but never wait on an SDK that has stalled.
      if (typeof it.return === 'function') {
        let t2;
        await Promise.race([Promise.resolve().then(() => it.return()).catch(() => {}), new Promise((resolve) => { t2 = setTimeout(resolve, 2000); if (t2.unref) t2.unref(); })]);
        clearTimeout(t2);
      }
    }

    // Reconcile. The usage on streamed assistant messages can carry a placeholder output count, so the
    // result's modelUsage is the better token total, and never book less than any figure says was spent:
    // the per-call sum, modelUsage priced from the table, and the SDK's own total_cost_usd.
    const sdkUsd = result && Number.isFinite(Number(result.total_cost_usd)) ? Number(result.total_cost_usd) : 0;
    const mu = result && result.modelUsage && typeof result.modelUsage === 'object' ? Object.values(result.modelUsage) : [];
    if (mu.length) {
      const sum = (k) => mu.reduce((a, x) => a + (Number(x && x[k]) || 0), 0);
      const fin = { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadInputTokens'), cacheWrite: sum('cacheCreationInputTokens'), cacheWrite1h: sum('cacheCreationEphemeral1hInputTokens') };
      for (const k of Object.keys(tokens)) tokens[k] = Math.max(tokens[k], fin[k]);
      const pf = priceUsage(fin, modelId);
      if (pf && pf.usd > usd) usd = pf.usd;
    }
    if (sdkUsd > usd) usd = sdkUsd;

    if (abortReason === 'hung') return fail(false, hungReason());
    if (abortReason === 'spend-cap') return fail(false, capReason());
    if (!result) return fail(false, inited ? 'the SDK run ended without a result' : 'the SDK run produced no messages');

    const text = scrub((result.subtype === 'success' && typeof result.result === 'string' && result.result.trim()) || lastText, key).trim();
    if (result.subtype !== 'success' || result.is_error) {
      const errs = Array.isArray(result.errors) ? result.errors.join('; ') : '';
      const why = scrub(errs || (result.subtype === 'success' ? text : '') || `${result.subtype}${lastAssistantError ? ` (${lastAssistantError})` : ''}`, key).replace(/\s+/g, ' ').trim();
      if (isWorkspaceMissing({ text: why })) { noteFailure(WORKSPACE_HINT); return fail(true, WORKSPACE_HINT); }
      if (isSpendLimit({ status: 400, text: why })) { const r = `workspace limit: ${why}`.slice(0, 200); noteFailure(r, true); return fail(true, r); }
      if ((lastAssistantError && AUTH_ERRORS.has(lastAssistantError)) || isUnavailable({ text: why })) { const r = `SDK: ${why}`.slice(0, 200); noteFailure(r); return fail(true, r); }
      return fail(false, `SDK: ${why}`.slice(0, 200));
    }
    const stop = result.stop_reason || lastStop;
    if (!text) return fail(false, `the model returned no text (stop_reason ${stop})`);
    if (requireVerdict) {
      if (['max_tokens', 'refusal', 'pause_turn'].includes(stop)) return fail(false, `the review was cut off (stop_reason ${stop}); no usable verdict`);
      if (!hasVerdict(text)) return fail(false, `the review has no VERDICT line (stop_reason ${stop})`);
    }
    bookCost(true);
    return { ok: true, text, usd, turns: turnCount, tokens, model: modelId, stopReason: stop, path: 'sdk', sdkUsd, notes, init, userGuards: guards, ...(ledgerError ? { ledgerError } : {}) };
  } catch (e) {
    stopTimers();
    const reason = scrub(String((e && e.message) || e), key).slice(0, 200);
    if (abortReason === 'hung') return fail(false, hungReason());
    if (abortReason === 'spend-cap') return fail(false, capReason());
    if (e && e.configFailure) noteFailure(reason);
    return fail(!!(e && e.configFailure), reason);
  }
}
