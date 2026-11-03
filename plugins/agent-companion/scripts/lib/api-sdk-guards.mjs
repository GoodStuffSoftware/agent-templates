// api-sdk-guards.mjs — the operator's user-level PreToolUse command hooks, run as guards in SDK reviewer sessions.
//
// The SDK reviewer (scripts/lib/api-sdk-run.mjs) loads project settings and ONLY this plugin; user settings are left out on
// purpose, because they would pull in every user plugin, MCP server and skill. That also drops the user's own guard hooks
// (e.g. a command guard that requires a backup before destructive git, secret protection). This module brings back just those:
// it reads `hooks.PreToolUse` from the user settings file and wraps every `command` hook as an Agent SDK programmatic hook
// callback (the `hooks` query option: event -> [{ matcher, hooks: [callback], timeout }]). Nothing else from the user settings
// is read or loaded.
//
// What Claude Code does with a PreToolUse command hook (https://code.claude.com/docs/en/hooks, checked 2026-11-03), and what this mirrors:
//   - stdin is the hook input JSON (session_id, cwd, hook_event_name, tool_name, tool_input, tool_use_id, ...): the SDK hands the callback that same object;
//   - exit 2 blocks the call and stderr is the reason; any other non-zero code is a non-blocking error (the call proceeds);
//   - exit 0 with a JSON object on stdout: hookSpecificOutput.permissionDecision "deny" blocks (the docs name decision "block" as
//     not used for PreToolUse; the legacy form is still read here and blocks too, the safe side for a guard);
//   - the default command timeout is 600 seconds, `timeout` is in seconds; a timed-out hook is cancelled and does NOT block, unless the hook
//     sets `onFailure: "block"` (then a timeout or a spawn error blocks);
//   - the matcher filters on the tool name (the SDK applies its own matcher semantics to the matcher string, so it is passed through);
//   - a hook's `if` field filters further with a permission rule such as "Bash(git push *)"; supported here for Bash and PowerShell command
//     rules and bare tool names; a hook with any other `if` is skipped and counted (it cannot be evaluated faithfully);
//   - `async: true` hooks cannot block and are skipped; `disableAllHooks: true` in the user settings turns the whole set off.
// Only PreToolUse is wrapped: the other events are lead-oriented and some inject context. An allow from a user hook is never passed on as
// an allow (the callback returns {} for it), and updatedInput / additionalContext are dropped: these hooks are guards, nothing more.
//
// Output is counts and hook basenames only: commands and settings contents can hold secrets and are never printed or returned.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_HOOK_TIMEOUT_S = 600; // Claude Code's default for command hooks
const OUTPUT_CAP = 64 * 1024;
const REASON_CAP = 500;

// The config dir the way Claude Code resolves it: CLAUDE_CONFIG_DIR, else ~/.claude.
export const userConfigDir = (env = process.env, home = homedir()) => {
  const d = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  return d ? resolve(d) : join(home, '.claude');
};

const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();

// A short, secret-free label for a hook command: the basename of the first path-like token, skipping interpreters and flags.
const RUNNERS = new Set(['node', 'nodejs', 'bash', 'sh', 'zsh', 'python', 'python3', 'py', 'pwsh', 'powershell', 'npx', 'bun', 'deno', 'env', 'exec', 'cmd', 'cmd.exe']);
export function hookName(command) {
  const toks = String(command || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (const raw of toks) {
    const t = raw.replace(/^["']|["']$/g, '');
    if (!t || t.startsWith('-') || RUNNERS.has(t.toLowerCase()) || /^\w+=/.test(t)) continue;
    const b = basename(t.replace(/\\/g, '/')).replace(/[^\w.@+-]/g, '').slice(0, 60);
    if (b) return b;
  }
  return 'hook';
}

// --- the `if` filter ------------------------------------------------------------------------------

const RULE_RE = /^([A-Za-z_][\w-]*)(?:\(([\s\S]*)\))?$/;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// null when the rule is not one this module can evaluate.
export function parseIfRule(rule) {
  if (rule === undefined || rule === null || rule === '') return { any: true };
  const m = RULE_RE.exec(String(rule).trim());
  if (!m) return null;
  const [, tool, pattern] = m;
  if (pattern === undefined || pattern === '' || pattern === '*') return { tool };
  if (!SHELL_TOOLS.has(tool)) return null;
  let src = pattern.trim();
  let prefixOnly = false;
  if (src.endsWith(':*')) { src = src.slice(0, -2); prefixOnly = true; } // legacy "git push:*"
  const optionalTail = src.endsWith(' *'); // "git push *" also matches the bare "git push"
  if (optionalTail) src = src.slice(0, -2);
  const body = src.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const re = new RegExp(`^${body}${prefixOnly || optionalTail ? '(?:\\s[\\s\\S]*)?' : ''}$`, 's');
  return { tool, re };
}
export function ifMatches(parsed, input) {
  if (!parsed || parsed.any) return true;
  if (!input || input.tool_name !== parsed.tool) return false;
  if (!parsed.re) return true;
  const cmd = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : '';
  const parts = [cmd, ...cmd.split(/&&|\|\||[;|\n]/)].map((s) => s.trim()).filter(Boolean);
  return parts.some((p) => parsed.re.test(p));
}

// --- reading the user settings ----------------------------------------------------------------------

function ownsCommand(command, pluginRoot) {
  const c = norm(command);
  if (c.includes('claude_plugin_root')) return true;
  return !!pluginRoot && c.includes(norm(pluginRoot).replace(/\/+$/, ''));
}

// -> { hooks: [{ matcher, command, args, timeoutS, ifRule, blockOnFailure, name }], skipped: { plugin, other }, disabled }
export function readUserPreToolUseHooks({ configDir, pluginRoot = '' }) {
  const out = { hooks: [], skipped: { plugin: 0, other: 0 }, disabled: false };
  let settings;
  try { settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')); } catch { return out; }
  if (!settings || typeof settings !== 'object') return out;
  if (settings.disableAllHooks === true) { out.disabled = true; return out; }
  const groups = settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  for (const g of groups) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) continue;
    const matcher = typeof g.matcher === 'string' ? g.matcher : undefined;
    for (const h of g.hooks) {
      if (!h || typeof h !== 'object' || h.type !== 'command' || typeof h.command !== 'string' || !h.command.trim()) { out.skipped.other++; continue; }
      if (ownsCommand(h.command, pluginRoot)) { out.skipped.plugin++; continue; }
      if (h.async === true) { out.skipped.other++; continue; }
      const ifRule = parseIfRule(h.if);
      if (!ifRule) { out.skipped.other++; continue; }
      const t = Number(h.timeout);
      out.hooks.push({
        matcher, command: h.command, args: Array.isArray(h.args) && h.args.every((a) => typeof a === 'string') ? h.args : null,
        timeoutS: Number.isFinite(t) && t > 0 ? t : DEFAULT_HOOK_TIMEOUT_S, ifRule, blockOnFailure: h.onFailure === 'block', name: hookName(h.command),
      });
    }
  }
  return out;
}

// --- running one hook -------------------------------------------------------------------------------

const cap = (s) => (s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) : s);
const clean = (s, key) => {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  if (key) t = t.split(key).join('[redacted]');
  return t.slice(0, REASON_CAP);
};

// Runs the hook command with the hook input on stdin. -> { exit: number|null, stdout, stderr, timedOut, error }. Never throws.
export function runHookCommand(h, input, { env, cwd, spawnImpl = spawn, gitBash = '' }) {
  return new Promise((resolveRun) => {
    let done = false;
    let stdout = '';
    let stderr = '';
    let child = null;
    let timer = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolveRun({ exit: null, stdout, stderr, timedOut: false, error: null, ...r }); };
    try {
      const opts = { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
      if (h.args) child = spawnImpl(h.command, h.args, opts);
      else if (gitBash) child = spawnImpl(gitBash, ['-c', h.command], opts); // Claude Code runs hook commands in Git Bash on Windows
      else child = spawnImpl(h.command, [], { ...opts, shell: true });
    } catch (e) { finish({ error: String((e && e.code) || (e && e.message) || e) }); return; }
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ timedOut: true }); }, Math.max(1, h.timeoutS * 1000));
    if (timer.unref) timer.unref();
    child.stdout.on('data', (d) => { stdout = cap(stdout + d); });
    child.stderr.on('data', (d) => { stderr = cap(stderr + d); });
    child.on('error', (e) => finish({ error: String((e && e.code) || (e && e.message) || e) }));
    child.on('close', (code) => finish({ exit: code }));
    child.stdin.on('error', () => {}); // a hook that exits without reading stdin
    try { child.stdin.end(JSON.stringify(input)); } catch { /* the close handler reports it */ }
  });
}

// The Claude Code result mapping. -> { deny: boolean, reason }
export function mapHookResult(h, r, key = '') {
  const block = (reason) => ({ deny: true, reason: clean(reason, key) || `blocked by user guard ${h.name}` });
  if (r.timedOut || r.error) return h.blockOnFailure ? block(`user guard ${h.name} ${r.timedOut ? 'timed out' : 'failed to run'}`) : { deny: false, reason: '' };
  if (r.exit === 2) return block(r.stderr || r.stdout);
  if (r.exit !== 0) return h.blockOnFailure ? block(r.stderr) : { deny: false, reason: '' };
  const text = String(r.stdout || '').trim();
  if (text.startsWith('{')) {
    let j = null;
    try { j = JSON.parse(text); } catch { /* plain text: no decision */ }
    if (j && typeof j === 'object') {
      const hso = j.hookSpecificOutput && typeof j.hookSpecificOutput === 'object' ? j.hookSpecificOutput : {};
      if (hso.permissionDecision === 'deny') return block(hso.permissionDecisionReason || j.reason);
      if (j.decision === 'block') return block(j.reason || hso.permissionDecisionReason);
    }
  }
  return { deny: false, reason: '' };
}

// --- the SDK hooks option -----------------------------------------------------------------------------

// The `hooks` option for query(): { PreToolUse: [{ matcher?, hooks: [callback], timeout }] }, or null when there is nothing to wrap.
// `env` is where the user's config dir is resolved; `childEnv` is the reviewer child env the hook commands run in (plus AC_REVIEWER_SESSION=1
// and CLAUDE_PROJECT_DIR; the review key is dropped from it, a user command has no business with it).
// -> { hooks, summary: { wrapped, names, skippedPlugin, skippedOther, disabled } }
export function buildUserGuards({ configDir, env = process.env, childEnv = {}, cwd = process.cwd(), pluginRoot = '', key = '', reviewerEnvName = 'AC_REVIEWER_SESSION', spawnImpl = spawn, home = homedir() }) {
  const dir = configDir || userConfigDir(env, home);
  const parsed = readUserPreToolUseHooks({ configDir: dir, pluginRoot });
  const summary = { wrapped: 0, names: [], skippedPlugin: parsed.skipped.plugin, skippedOther: parsed.skipped.other, disabled: parsed.disabled };
  if (!parsed.hooks.length) return { hooks: null, summary };
  const hookEnv = { ...childEnv, [reviewerEnvName]: '1', CLAUDE_PROJECT_DIR: cwd };
  delete hookEnv.ANTHROPIC_API_KEY;
  // The reviewer child env points CLAUDE_CONFIG_DIR at a private empty dir (only the SDK binary should use that). A user guard keeps its state
  // (backup records, allowlists) in the user's REAL config dir, so it gets that one: the dir the settings were read from, which is
  // CLAUDE_CONFIG_DIR as the parent had it, else the default (the variable removed, so the guard resolves ~/.claude itself).
  if (configDir) hookEnv.CLAUDE_CONFIG_DIR = dir;
  else if (env && typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim()) hookEnv.CLAUDE_CONFIG_DIR = resolve(env.CLAUDE_CONFIG_DIR.trim());
  else delete hookEnv.CLAUDE_CONFIG_DIR;
  const gitBash = process.platform === 'win32' && childEnv.CLAUDE_CODE_GIT_BASH_PATH ? String(childEnv.CLAUDE_CODE_GIT_BASH_PATH) : '';
  const matchers = parsed.hooks.map((h) => {
    const callback = async (input) => {
      try {
        if (!input || input.hook_event_name !== 'PreToolUse' || !ifMatches(h.ifRule, input)) return {};
        const r = await runHookCommand(h, input, { env: hookEnv, cwd, spawnImpl, gitBash });
        const m = mapHookResult(h, r, key);
        return m.deny ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: m.reason } } : {};
      } catch { return {}; } // fail-safe: a guard that breaks does not stop the review
    };
    return { ...(h.matcher !== undefined && h.matcher !== '' ? { matcher: h.matcher } : {}), hooks: [callback], timeout: Math.ceil(h.timeoutS) + 5 };
  });
  summary.wrapped = matchers.length;
  summary.names = parsed.hooks.map((h) => h.name);
  return { hooks: { PreToolUse: matchers }, summary };
}
