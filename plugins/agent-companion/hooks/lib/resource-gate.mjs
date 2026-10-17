// Resource gate: classify a Bash command as heavy (or not) and say how to run it
// through the machine-wide resource queue (scripts/resource-queue.mjs).
//
// Pure logic, no hook I/O: hooks/bash-tail.mjs calls gateDecision() as the FIRST
// step of its single rewriting step (only one PreToolUse hook's updatedInput
// survives a call, and bash-tail already rewrites), then lets its output tail
// wrap whatever command that step produced. Classes, weights and per-user
// values live in config/resource-rules.json (loaded only when a command
// actually is heavy, so a plain `ls` costs a string scan and nothing else).
// Measured classes and the must-match / must-not-match lists: the 2026-10-17
// heavy-command research (tasks/usage-why-2026-10-06/r-heavy-commands-1017-detail.md).
//
// Rules of the classifier:
//   - a command is split into shell segments (&&, ||, ;, |, &, newline); each
//     segment is classified on its own words, so text inside quotes and heredoc
//     bodies is never a command (`echo "npm ci"`, `git commit -m "run vitest"`);
//   - `bash -c "..."`, `sh -c`, `cmd /c`, `powershell -Command` are looked into;
//   - VAR=x, env, cross-env, time, nohup, nice, command, start /b prefixes are
//     stripped; a segment led by RESOURCE_QUEUE=0 is skipped;
//   - a segment already wrapped (`... resource-queue.mjs run ... --`, ci-budget run)
//     passes through without looking at what is inside it;
//   - agent-templates' own ci-local (and a push in a repo whose pre-push is
//     ci-local) passes through: it holds its own lease.
// Everything fails open: any error here means "not heavy".

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
export const GATE_MODES = ['rewrite', 'deny', 'hint', 'off'];
export const DEFAULT_GATE_MODE = 'deny';
export const TELEMETRY_STREAM = 'resource-gate.jsonl';
const MAX_DEPTH = 3;

/** The setting, normalised; anything unknown is the shipped default. */
export function gateMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return GATE_MODES.includes(v) ? v : DEFAULT_GATE_MODE;
}

/** True when the environment of the hook says "do not queue": opt-out, or already inside a queued run. */
export function gateDisabledByEnv(env = process.env) {
  if (String(env.RESOURCE_QUEUE ?? '') === '0') return true;
  if (env.AC_RESOURCE_LEASE) return true;
  return false;
}

// ---------------------------------------------------------------- lexing

/**
 * Index of the `)` that closes the `$(` at s[i] (s.length when unbalanced). Quote and
 * heredoc aware: a heredoc body is data (apostrophes, quotes and parentheses in it do
 * not count), so a commit message in `"$(cat <<'EOF' ... EOF)"` never leaks out as commands.
 */
function skipDollarParen(s, i) {
  let depth = 0;
  const pend = [];
  for (let j = i + 2; j < s.length; j += 1) {
    const c = s[j];
    if (c === '\\') { j += 1; continue; }
    if (c === "'") { const e = s.indexOf("'", j + 1); if (e < 0) return s.length; j = e; continue; }
    if (c === '"') {
      for (j += 1; j < s.length && s[j] !== '"'; j += 1) if (s[j] === '\\') j += 1;
      continue;
    }
    if (c === '<' && s[j + 1] === '<' && s[j + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_]+))/.exec(s.slice(j, j + 200));
      if (m) { pend.push({ word: m[2] ?? m[3] ?? m[4], strip: m[1] === '-' }); j += m[0].length - 1; continue; }
    }
    if (c === '\n' && pend.length) {
      let p = j + 1;
      while (pend.length) {
        const h = pend.shift();
        while (p < s.length) {
          let e = s.indexOf('\n', p);
          if (e < 0) e = s.length;
          const line = s.slice(p, e).replace(/\r$/, '');
          p = Math.min(s.length, e + 1);
          if ((h.strip ? line.trim() : line) === h.word) break;
        }
      }
      j = p - 1;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') { if (depth === 0) return j; depth -= 1; }
  }
  return s.length;
}

/**
 * Split a command into segments with their offsets: [{ start, end, text }], plus
 * the structure flags 'heredoc' and 'group' (parentheses or braces) that make an
 * in-place rewrite unsafe. Quotes, backslashes, comments, $(...) and backticks
 * are skipped as text; heredoc bodies are cut out.
 */
export function scanCommand(command) {
  const s = String(command ?? '');
  const segs = [];
  const flags = new Set();
  let start = 0;
  let quote = '';
  const pending = []; // heredoc terminators waiting for the next newline
  const push = (end) => { const text = s.slice(start, end); if (text.trim()) segs.push({ start, end, text }); };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    const n = s[i + 1];
    if (quote === "'") { if (c === "'") quote = ''; continue; }
    if (quote === '"') {
      if (c === '\\') { i += 1; continue; }
      if (c === '$' && n === '(') { i = skipDollarParen(s, i); continue; }
      if (c === '"') quote = '';
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '\\') { i += 1; continue; }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      push(i);
      while (i < s.length && s[i] !== '\n') i += 1;
      start = i; i -= 1; // the newline ends the (empty) segment
      continue;
    }
    if (c === '$' && n === '(') {
      i = skipDollarParen(s, i);
      continue;
    }
    if (c === '`') { const j = s.indexOf('`', i + 1); i = j < 0 ? s.length : j; continue; }
    if (c === '<' && n === '<' && s[i + 2] === '<') { i += 2; continue; } // here-string
    if (c === '<' && n === '<') {
      flags.add('heredoc');
      const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_]+))/.exec(s.slice(i));
      if (m) pending.push({ word: m[2] ?? m[3] ?? m[4], strip: m[1] === '-' });
      i += 1;
      continue;
    }
    if (c === '\n') {
      push(i);
      let j = i + 1;
      while (pending.length) {
        const h = pending.shift();
        for (;;) {
          if (j >= s.length) break;
          let e = s.indexOf('\n', j);
          if (e < 0) e = s.length;
          const line = s.slice(j, e);
          j = e + 1;
          if ((h.strip ? line.trim() : line.replace(/\r$/, '')) === h.word) break;
        }
      }
      i = Math.min(j, s.length) - 1;
      start = i + 1;
      continue;
    }
    if (c === '&' && n === '&') { push(i); i += 1; start = i + 1; continue; }
    if (c === '|') { push(i); if (n === '|' || n === '&') i += 1; start = i + 1; continue; }
    if (c === ';') { push(i); start = i + 1; continue; }
    if (c === '&') {
      if (n === '>' || s[i - 1] === '>' || s[i - 1] === '<') continue; // 2>&1, &>file, <&3
      push(i); start = i + 1; continue;
    }
    if (c === '(' || c === ')') { flags.add('group'); push(i); start = i + 1; continue; }
    if (c === '{' || c === '}') {
      if ((i === 0 || /\s/.test(s[i - 1])) && (n === undefined || /\s/.test(n))) { flags.add('group'); push(i); start = i + 1; }
      continue;
    }
  }
  push(s.length);
  return { segments: segs, flags };
}

const REDIRECT_ONLY = /^\d*(?:>>?|<|&>>?|>&|<&)$/;
const REDIRECT_JOINED = /^(?:\d*(?:>>?|<|>&|<&)\S+|&>>?\S+)$/;

/** The unquoted words of a segment, redirections removed. */
export function wordsOf(text) {
  const s = String(text);
  const out = [];
  let w = '';
  let has = false;
  let quote = '';
  const end = () => { if (has) out.push(w); w = ''; has = false; };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = ''; else w += c; continue; }
    if (quote === '"') {
      if (c === '\\' && i + 1 < s.length) { w += s[i + 1]; i += 1; continue; }
      if (c === '"') quote = ''; else w += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < s.length) { w += s[i + 1]; has = true; i += 1; continue; }
    if (/\s/.test(c)) { end(); continue; }
    w += c; has = true;
  }
  end();
  const words = [];
  for (let i = 0; i < out.length; i += 1) {
    if (REDIRECT_ONLY.test(out[i])) { i += 1; continue; }
    if (REDIRECT_JOINED.test(out[i])) continue;
    words.push(out[i]);
  }
  return words;
}

const baseName = (w) => String(w).replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
const isFlag = (w) => /^-/.test(w);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);

/** Strip what can sit before the real command. Returns { words, optOut }. */
function stripPrefix(words) {
  let w = words.slice();
  let optOut = false;
  for (let guard = 0; guard < 20 && w.length; guard += 1) {
    const b = baseName(w[0]);
    if (ASSIGN.test(w[0])) { if (/^RESOURCE_QUEUE=0$/.test(w[0])) optOut = true; w = w.slice(1); continue; }
    if (KEYWORDS.has(w[0])) { w = w.slice(1); continue; }
    if (b === 'env' || b === 'cross-env' || b === 'cross-env-shell') {
      w = w.slice(1);
      while (w.length && (isFlag(w[0]) || ASSIGN.test(w[0]))) { if (w[0] === 'RESOURCE_QUEUE=0') optOut = true; w = w.slice(1); }
      continue;
    }
    if (b === 'time' || b === 'nohup' || b === 'command' || b === 'nice' || b === 'exec') { w = w.slice(1); continue; }
    if (b === 'timeout' && w.length > 2) { w = w.slice(isFlag(w[1]) ? 3 : 2); continue; }
    if (b === 'start' && w.length > 1 && /^\/{1,2}[a-z]/i.test(w[1])) { w = w.slice(1); while (w.length && /^\/{1,2}[a-z]/i.test(w[0])) w = w.slice(1); continue; }
    break;
  }
  return { words: w, optOut };
}

// ---------------------------------------------------------------- context (fs seams)

function defaultCtx(cwd) {
  return { cwd: cwd || process.cwd(), exists: existsSync, read: (f) => readFileSync(f, 'utf8') };
}

function findUp(ctx, name, from = ctx.cwd) {
  let dir = resolve(from);
  for (let i = 0; i < 8; i += 1) {
    if (ctx.exists(join(dir, name))) return join(dir, name);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** { found, scripts } for the nearest package.json at or above cwd. */
function packageScripts(ctx) {
  const f = findUp(ctx, 'package.json');
  if (!f) return { found: false, scripts: {} };
  try {
    const j = JSON.parse(ctx.read(f));
    return { found: true, scripts: j && typeof j.scripts === 'object' && j.scripts ? j.scripts : {} };
  } catch { return { found: true, scripts: {} }; }
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------- classification

const TEST_MARK = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.(?:test|spec)\./i;
const FILE_EXT = /\.[a-z0-9]{1,5}$/i;
const VITEST_VALUE_FLAGS = new Set(['-t', '--testNamePattern', '--reporter', '--outputFile', '--config', '-c', '--root', '-r', '--project', '--pool', '--shard',
  '--dir', '--environment', '--mode', '--maxWorkers', '--minWorkers', '--exclude', '--retry', '--bail', '--silent', '--logHeapUsage', '--testTimeout', '--hookTimeout']);
const PLAYWRIGHT_VALUE_FLAGS = new Set(['--project', '-p', '--reporter', '--config', '-c', '--grep', '-g', '--grep-invert', '--workers', '-j', '--retries', '--timeout', '--shard', '--output', '--max-failures']);

/** Positional (non-flag) tokens of args, skipping the values of known value flags. `--` itself is dropped. */
function positionals(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') continue;
    if (isFlag(a)) { if (!a.includes('=') && valueFlags.has(a)) i += 1; continue; }
    out.push(a);
  }
  return out;
}

const hasAny = (args, flags) => args.some((a) => flags.includes(a.split('=')[0]));

function vitestClass(args) {
  if (hasAny(args, ['--help', '-h', '--version', '--watch', '-w', '--ui', '--related', '--changed', '--shard', '-t', '--testNamePattern', '--typecheck'])) return null;
  const pos = positionals(args, VITEST_VALUE_FLAGS);
  const sub = pos[0];
  if (sub && ['list', 'init', 'related', 'bench', 'dev', 'watch', 'typecheck'].includes(sub)) return null;
  const rest = sub === 'run' ? pos.slice(1) : pos;
  if (!rest.length) return 'vitest-full';
  // Any positional is a filter. A directory-looking path still boots many files (medium); a file or substring is targeted.
  if (rest.every((p) => TEST_MARK.test(p) || (!/[\\/]/.test(p) && FILE_EXT.test(p)))) return null;
  if (rest.some((p) => /[\\/]/.test(p) && !TEST_MARK.test(p) && !FILE_EXT.test(p))) return 'vitest-dir';
  return null;
}

function e2eClass(args, valueFlags) {
  if (hasAny(args, ['--list', '--help', '-h', '--version', '-V', '--version'])) return null;
  const pos = positionals(args, valueFlags);
  return pos.length ? 'e2e-spec' : 'e2e';
}

/** tool name and its args for a runner invoked through npx / pnpm exec / yarn / npm exec, or the command itself. */
function peel(words) {
  const cmd = baseName(words[0]);
  let args = words.slice(1);
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') {
    while (args.length && isFlag(args[0])) args = args.slice(args[0] === '-p' || args[0] === '--package' ? 2 : 1);
    return args.length ? { tool: baseName(args[0]), args: args.slice(1), raw: args[0] } : null;
  }
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') {
    let a = args;
    while (a.length && isFlag(a[0]) && a[0] !== '--') a = a.slice(1);
    const verb = a[0];
    if (verb === 'exec' || verb === 'dlx' || verb === 'x') {
      let r = a.slice(1);
      while (r.length && (isFlag(r[0]) || r[0] === '--')) r = r.slice(1);
      return r.length ? { tool: baseName(r[0]), args: r.slice(1), raw: r[0] } : null;
    }
    if (verb && cmd !== 'npm' && ['vitest', 'playwright', 'eslint', 'tsc', 'vue-tsc', 'biome'].includes(baseName(verb))) {
      return { tool: baseName(verb), args: a.slice(1), raw: verb };
    }
    return null;
  }
  return { tool: cmd, args, raw: words[0] };
}

function lintClass(tool, args) {
  if (hasAny(args, ['--version', '-v', '--help', '-h', '-V', '--init', '--print-config', '--list-files-only'])) return null;
  if (tool === 'biome') {
    const verb = args.find((a) => !isFlag(a));
    return verb === 'check' || verb === 'lint' ? 'lint' : null;
  }
  if (tool === 'eslint') {
    const pos = positionals(args, new Set(['--ext', '--config', '-c', '--format', '-f', '--rulesdir', '--parser', '--plugin', '--rule', '--cache-location', '--output-file', '-o', '--max-warnings', '--resolve-plugins-relative-to', '--ignore-pattern']));
    if (pos.length && pos.every((p) => /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i.test(p))) return null; // single files are quick
  }
  return 'lint';
}

function gradleClass(args) {
  const first = args.find((a) => !isFlag(a));
  if (hasAny(args, ['--version', '-v', '--help', '-h', '--stop', '--status'])) return null;
  if (first === undefined && !args.length) return null;
  if (first && ['tasks', 'help', 'projects', 'properties', 'dependencies', 'wrapper'].includes(first)) return null;
  return 'gradle';
}

function installClass(pm, args) {
  const flagsOnly = (a) => a.every((x) => isFlag(x));
  if (hasAny(args, ['-g', '--global', '--help', '-h', '--version'])) return null;
  if (pm === 'npm') {
    const verb = args.find((a) => !isFlag(a));
    if (verb === 'ci') return 'install';
    if (verb === 'install' || verb === 'i') return flagsOnly(args.slice(args.indexOf(verb) + 1)) ? 'install' : null;
    return null;
  }
  if (pm === 'pnpm') {
    const verb = args.find((a) => !isFlag(a));
    if (verb === 'install' || verb === 'i') return flagsOnly(args.slice(args.indexOf(verb) + 1)) ? 'install' : null;
    return null;
  }
  if (pm === 'yarn') {
    const verb = args.find((a) => !isFlag(a));
    if (verb === undefined || verb === 'install') return flagsOnly(args.slice(verb === undefined ? 0 : args.indexOf(verb) + 1)) ? 'install' : null;
    return null;
  }
  return null;
}

/** `git push` that will run a heavy pre-push hook. Returns 'push-gate', 'ci-local' (passes) or null. */
function pushClass(words, ctx) {
  const args = words.slice(1);
  let cwd = ctx.cwd;
  let hooksPath = null;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-c' && args[i + 1]) { const m = /^core\.hookspath=(.*)$/i.exec(args[i + 1]); if (m) hooksPath = m[1]; i += 2; continue; }
    if (a === '-C' && args[i + 1]) { cwd = isAbsolute(args[i + 1]) ? args[i + 1] : resolve(cwd, args[i + 1]); i += 2; continue; }
    if (isFlag(a)) { i += 1; continue; }
    break;
  }
  if (args[i] !== 'push') return null;
  const rest = args.slice(i + 1);
  if (hasAny(rest, ['--dry-run', '-n', '--delete', '-d', '--help'])) return null;
  const refs = rest.filter((a) => !isFlag(a));
  if (rest.includes('--tags') && refs.length <= 1) return null; // tags only (the remote name is the one positional)
  const root = findUp(ctx, '.git', cwd);
  const base = root ? dirname(root) : cwd;
  const candidates = [];
  if (hooksPath) candidates.push(isAbsolute(hooksPath) ? hooksPath : resolve(base, hooksPath));
  candidates.push(join(base, '.husky'), join(base, '.githooks'), join(base, '.git', 'hooks'));
  const hookDir = candidates.find((d) => ctx.exists(join(d, 'pre-push')));
  if (!hookDir) return null;
  // agent-templates: the pre-push hook is ci-local, which holds its own lease.
  if (ctx.exists(join(base, 'scripts', 'ci-local.mjs'))) return 'ci-local';
  if (lightPrePushHook(ctx, join(hookDir, 'pre-push'))) return null;
  return 'push-gate';
}

/**
 * True when a pre-push hook is known to be light: it has at least one command line
 * and every command line is git-lfs, echo, printf, true, `:` or exit (husky's
 * `. _/husky.sh` prelude is neutral). An unreadable, empty or unknown hook is
 * treated as heavy.
 */
export function lightPrePushHook(ctx, file) {
  let text;
  try { text = String(ctx.read(file) ?? ''); } catch { return false; }
  let commands = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^(?:\.|source)\s+.*husky\.sh["']?$/.test(line)) continue;
    if (/^(?:git[ -]lfs\b|command\s+-v\s+git-lfs\b|echo\b|printf\b|true\b|:(?:\s|$)|exit\s+\d+\s*$)/.test(line)) { commands += 1; continue; }
    return false;
  }
  return commands > 0;
}

/**
 * Classify one command's words. Returns { class } for a heavy command,
 * { pass: 'wrapped' | 'ci-local' } for one that must go through untouched, or null.
 * `ctx` has cwd/exists/read. `depth` bounds the look inside `bash -c`.
 */
export function classifyWords(rawWords, ctx, depth = 0) {
  const { words, optOut } = stripPrefix(rawWords);
  if (optOut || !words.length) return optOut ? { pass: 'opt-out' } : null;
  const cmd = baseName(words[0]);
  const args = words.slice(1);

  // Already in the queue (or in ci-budget's run wrapper): never look inside.
  const scriptArg = cmd === 'node' ? args.find((a) => !isFlag(a)) : words[0];
  const scriptBase = scriptArg ? baseName(scriptArg).replace(/\.mjs$/, '') : '';
  if (scriptBase === 'resource-queue' || scriptBase === 'ci-budget') {
    const after = cmd === 'node' ? args.slice(args.indexOf(scriptArg) + 1) : args;
    if (after[0] === 'run') return { pass: 'wrapped' };
  }
  if (cmd === 'node' && scriptBase === 'ci-local') return { pass: 'ci-local' };

  // A shell given a script: look inside.
  if (depth < MAX_DEPTH) {
    let inner = null;
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(cmd)) {
      const i = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
      if (i >= 0 && args[i + 1] !== undefined) inner = args[i + 1];
    } else if (cmd === 'cmd') {
      const i = args.findIndex((a) => /^\/{1,2}[ck]$/i.test(a));
      if (i >= 0) inner = args.slice(i + 1).join(' ');
    } else if (cmd === 'powershell' || cmd === 'pwsh') {
      const i = args.findIndex((a) => /^-(?:c|command)$/i.test(a));
      if (i >= 0) inner = args.slice(i + 1).join(' ');
    }
    if (inner !== null) {
      const found = classifyText(inner, ctx, depth + 1);
      const heavy = found.heavy[0];
      if (heavy) return { class: heavy.class, inner: true };
      return found.passed.length ? { pass: found.passed[0] } : null;
    }
  }

  const p = peel(words);
  if (!p) {
    // package-manager verbs and scripts
    return classifyPackageManager(cmd, args, ctx, depth);
  }
  const { tool, args: targs } = p;
  if (tool === 'npm' || tool === 'pnpm' || tool === 'yarn') return classifyPackageManager(tool, targs, ctx, depth);
  if (tool === 'playwright') {
    return targs[0] === 'test' ? (e2eClass(targs.slice(1), PLAYWRIGHT_VALUE_FLAGS) ? { class: e2eClass(targs.slice(1), PLAYWRIGHT_VALUE_FLAGS) } : null) : null;
  }
  if (tool === 'vitest') { const c = vitestClass(targs); return c ? { class: c } : null; }
  if (tool === 'eslint' || tool === 'tsc' || tool === 'vue-tsc' || tool === 'biome') { const c = lintClass(tool, targs); return c ? { class: c } : null; }
  if (tool === 'emulator') {
    return targs.some((a) => a.startsWith('@')) || targs.includes('-avd') ? { class: 'emulator' } : null;
  }
  if (tool === 'gradlew' || tool === 'gradle') { const c = gradleClass(targs); return c ? { class: c } : null; }
  if (tool === 'firebase') {
    return /^emulators:(?:start|exec)$/.test(targs.find((a) => !isFlag(a)) ?? '') ? { class: 'fs-emulator' } : null;
  }
  if (tool === 'cap') return ['sync', 'build', 'run'].includes(targs[0]) ? { class: 'gradle' } : null;
  if (tool === 'git') { const c = pushClass(words, ctx); return c === 'ci-local' ? { pass: 'ci-local' } : c ? { class: c } : null; }
  if (tool === 'node') {
    if (targs.includes('--test')) {
      const files = positionals(targs, new Set(['--test-concurrency', '--test-name-pattern', '--test-reporter', '--import', '--require', '-r', '--test-reporter-destination']));
      return files.some((f) => TEST_MARK.test(f)) ? null : { class: 'node-test-full' };
    }
    const script = targs.find((a) => !isFlag(a));
    if (script && /(?:^|\/)scripts\/run-(?:test-e2e|affected-e2e)\.mjs$/.test(script.replace(/\\/g, '/'))) {
      const c = e2eClass(targs.slice(targs.indexOf(script) + 1), new Set());
      return c ? { class: c } : null;
    }
    return null;
  }
  return null;
}

function classifyPackageManager(pm, args, ctx, depth) {
  if (pm !== 'npm' && pm !== 'pnpm' && pm !== 'yarn' && pm !== 'bun') return null;
  let a = args;
  while (a.length && isFlag(a[0])) a = a.slice(1);
  let verb = a[0];
  let after = a.slice(1);
  let script = null;
  if (verb === 'run' || verb === 'run-script') {
    script = after[0]; after = after.slice(1);
  } else if (verb === 'test' || verb === 't' || verb === 'tst') {
    script = 'test';
  } else if (pm !== 'npm' && verb && !['install', 'i', 'add', 'ci', 'exec', 'dlx', 'x', 'remove', 'rm', 'update', 'up', 'upgrade', 'link', 'init', 'create', 'info', 'list', 'ls', 'why', 'config', 'cache', 'store', 'view', 'outdated', 'audit', 'pack', 'publish', 'login', 'logout', 'whoami'].includes(verb)) {
    script = verb;
  }
  if (script === null) {
    const c = installClass(pm, args);
    return c ? { class: c } : null;
  }
  // e2e scripts
  if (/^test:e2e(?::affected)?$/.test(script)) {
    const c = e2eClass(after, new Set());
    return c ? { class: c } : null;
  }
  if (/^(?:build:apk\S*|android\S*|cap:(?:sync|build)\S*)$/.test(script)) return { class: 'gradle' };
  if (/^(?:lint|typecheck|type-check|check)$/.test(script)) return { class: 'lint' };
  if (/^test(?::unit|:ci|:coverage)?$/.test(script)) return resolveTestScript(script, after, ctx, depth);
  return null;
}

function resolveTestScript(script, after, ctx, depth) {
  const { found, scripts } = packageScripts(ctx);
  const extra = after.filter((x) => x !== '--');
  const body = typeof scripts[script] === 'string' ? scripts[script] : null;
  const asVitest = () => { const c = vitestClass(extra); return c ? { class: c } : null; };
  if (body !== null && depth < MAX_DEPTH) {
    const found2 = classifyText(`${body} ${extra.map(shq).join(' ')}`, ctx, depth + 1);
    if (found2.heavy[0]) return { class: found2.heavy[0].class };
    if (found2.passed.length) return { pass: found2.passed[0] };
    // A runner we classify by name (vitest, playwright) already answered above; only an unnamed one is a full run.
    return /\b(?:jest|mocha|ava|tap|karma|cypress)\b/.test(body) && !/\b(?:vitest|playwright)\b/.test(body) ? asVitest() : null;
  }
  if (!found) return asVitest(); // no package.json to read: `npm test` is a full run
  return null;
}

/**
 * Classify a whole command. Returns { heavy: [{ class, start, end }], passed: [reason], flags }.
 * `start`/`end` index the original command string.
 */
export function classifyText(command, ctx, depth = 0) {
  const out = { heavy: [], passed: [], flags: new Set() };
  let scanned;
  try { scanned = scanCommand(command); } catch { return out; }
  out.flags = scanned.flags;
  for (const seg of scanned.segments) {
    let r = null;
    try { r = classifyWords(wordsOf(seg.text), ctx, depth); } catch { r = null; }
    if (!r) continue;
    if (r.pass) { out.passed.push(r.pass); continue; }
    if (r.class) out.heavy.push({ class: r.class, start: seg.start, end: seg.end });
  }
  return out;
}

/** Classify with the real file system. */
export function classifyCommand(command, { cwd, exists, read } = {}) {
  const ctx = defaultCtx(cwd);
  if (exists) ctx.exists = exists;
  if (read) ctx.read = read;
  return classifyText(command, ctx, 0);
}

// ---------------------------------------------------------------- rewriting

/** The shell text that runs `segment` under the queue as class `cls`. */
export function wrapSegment(segment, cls, launcher) {
  return `node ${shq(launcher)} run --class ${cls} --label ${cls} -- ${shq(segment.trim())}`;
}

/**
 * Rewrite a command so every heavy segment runs through the queue. In place per
 * segment when the structure allows (so `cd x && npm test` keeps its cd); the whole
 * command as one wrapped run when it has a heredoc or a group (parentheses, braces).
 * `heavyestOf(classes)` picks the class for a whole-command wrap.
 */
export function rewriteCommand(command, heavy, flags, launcher, heavyestOf = (cs) => cs[0]) {
  if (!heavy.length) return command;
  if (flags.has('heredoc') || flags.has('group')) {
    return wrapSegment(command, heavyestOf(heavy.map((h) => h.class)), launcher);
  }
  let s = String(command);
  for (const h of [...heavy].sort((a, b) => b.start - a.start)) {
    const seg = s.slice(h.start, h.end);
    const lead = seg.match(/^\s*/)[0];
    const trail = seg.match(/\s*$/)[0];
    s = `${s.slice(0, h.start)}${lead}${wrapSegment(seg, h.class, launcher)}${trail}${s.slice(h.end)}`;
  }
  return s;
}

function toSlash(p) { return String(p).replace(/\\/g, '/'); }

async function loadRulesSafe(env) {
  try {
    const m = await import(pathToFileURL(join(SCRIPTS, 'lib', 'resource-rules.mjs')).href);
    return { rules: m.loadRules(env), claudeHome: m.claudeHome(env) };
  } catch { return null; }
}

function launcherFor(claudeHome, exists = existsSync) {
  const stable = join(claudeHome, 'agent-companion', 'bin', 'resource-queue.mjs');
  return toSlash(exists(stable) ? stable : join(SCRIPTS, 'resource-queue.mjs'));
}

const boxOf = (rules, id) => {
  const c = (rules?.classes ?? []).find((x) => x.id === id);
  return c ? Math.max(0, Math.trunc(c.box ?? 0)) : 0;
};
const isClass = (rules, id) => {
  const c = (rules?.classes ?? []).find((x) => x.id === id);
  return Boolean(c && ((c.box ?? 0) > 0 || Object.keys(c.resources ?? {}).length));
};

/**
 * What the gate does with a Bash command.
 *   mode: 'rewrite' | 'deny' | 'hint' | 'off'
 *   rewriteAllowed: false (or a function of the wrapped command returning false) when the
 *     permission mode or a permission rule makes a rewrite unsafe; rewrite mode then denies
 * Returns { action: 'none' | 'deny' | 'hint' | 'rewrite', classes, command?, text? }.
 * Never throws; any error is { action: 'none' }.
 */
export async function gateDecision(command, { cwd, mode = DEFAULT_GATE_MODE, env = process.env, rewriteAllowed = true, exists, read, rulesInline = null } = {}) {
  const none = { action: 'none', classes: [] };
  try {
    if (mode === 'off' || typeof command !== 'string' || !command.trim() || gateDisabledByEnv(env)) return none;
    const found = classifyCommand(command, { cwd, exists, read });
    if (!found.heavy.length) return none;
    const loaded = rulesInline ? { rules: rulesInline, claudeHome: rulesInline.claudeHome ?? '' } : await loadRulesSafe(env);
    if (!loaded) return none;
    const { rules } = loaded;
    const heavy = found.heavy.filter((h) => isClass(rules, h.class));
    if (!heavy.length) return none;
    const classes = [...new Set(heavy.map((h) => h.class))];
    const launcher = launcherFor(loaded.claudeHome, exists ?? existsSync);
    const heaviest = (cs) => cs.slice().sort((a, b) => boxOf(rules, b) - boxOf(rules, a))[0];
    const wrapped = rewriteCommand(command, heavy, found.flags, launcher, heaviest);
    const weight = classes.map((c) => `${c} (box ${boxOf(rules, c)})`).join(', ');
    const canRewrite = typeof rewriteAllowed === 'function' ? Boolean(rewriteAllowed(wrapped)) : Boolean(rewriteAllowed);
    const effective = mode === 'rewrite' && !canRewrite ? 'deny' : mode;
    if (effective === 'rewrite') {
      return { action: 'rewrite', classes, command: wrapped, text: `Heavy command (${weight}) runs through the machine-wide resource queue so agents do not overload the box; it waits for its turn if the box is busy.` };
    }
    const big = classes.some((c) => ['e2e', 'e2e-spec', 'push-gate', 'vitest-full', 'node-test-full', 'emulator'].includes(c));
    const how = `Run it through the machine-wide resource queue so agents do not overload the box. Exact command to run instead:\n${wrapped}\n`;
    const bg = big ? 'For a full suite also pass run_in_background: true, since time spent waiting in the queue counts against the 10-minute foreground limit. ' : '';
    if (effective === 'hint') {
      return { action: 'hint', classes, command: wrapped, text: `Heavy command (${weight}). ${how}${bg}`.trim() };
    }
    const why = mode === 'rewrite' ? ' (rewrite does not apply in this permission mode or next to a permission rule, so it is a denial)' : '';
    return {
      action: 'deny', classes, command: wrapped,
      text: `Heavy command (${weight}) not run${why}. ${how}${bg}Prefix RESOURCE_QUEUE=0 only when the queue itself is broken.`,
    };
  } catch { return none; }
}
