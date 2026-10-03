// Bash output tail: the rules behind hooks/bash-tail.mjs, kept apart from the
// hook so tests drive the trigger logic and the generated shell directly.
// Design record: docs/adr/0004-bash-output-tail.md at the repo root.
//
// What it does: a PreToolUse hook on Bash rewrites a known long-running
// command (a test run, a build, an install) so its combined output goes to a
// file, and only a short tail plus the file's path comes back into context.
// Every character a tool returns is re-read from cache on every later call
// of that agent, so a 3,000-line test run is paid for hundreds of times.
//
// Two decisions live here:
//   analyze(command)  - is this a command we may wrap? { runner, blockers }.
//                       Wrapped only when a known runner is present AND no
//                       blocker is (pipe, redirect, background, subshell,
//                       command substitution, compound statement, watcher,
//                       machine-readable output flag, a word that ends or
//                       replaces the shell).
//   wrapCommand(...)  - the shell text that replaces the command.
//
// The wrapper is plain POSIX sh (works in Git Bash on Windows, bash, zsh):
//   - the original command runs inside `{ ...; }` (NOT a subshell), so `cd`
//     and variable changes still reach the shell the tool tracks;
//   - the exit status is captured at once and re-raised with `(exit N)`, so
//     the tool sees exactly the status the command had;
//   - output of 80 lines / 8000 bytes or less is printed whole (nothing to
//     save, nothing hidden) and the file removed;
//   - above that: a header with exit code, size and the full-output path, then
//     the last 60 lines of a FAILED run (the failure summary of every runner
//     we trigger on is at the end) or the last 20 of a passing one;
//   - if the output file cannot be created, the ORIGINAL command runs as it
//     was written (the if/else below), so wrapping can never stop a command.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const FULL_MAX_LINES = 80;
export const FULL_MAX_BYTES = 8000;
export const TAIL_FAILED_LINES = 60;
export const TAIL_PASSED_LINES = 20;
export const LINE_CUT_CHARS = 1000;
export const KEEP_FILES_MS = 3 * 24 * 60 * 60 * 1000;
export const TELEMETRY_STREAM = 'bash-tail.jsonl';

// ---------------------------------------------------------------- lexing

// A deliberately small shell lexer. It does not try to understand shell; it
// finds the structure that makes wrapping unsafe, and splits the simple
// commands so each one's first words can be matched against the runner list.
// Anything it is unsure about it reports as a blocker, never as safe.
export function lex(command) {
  const flags = new Set();
  const segments = [];
  let words = [];
  let word = '';
  let has = false; // a word is open (so '' counts as a word)
  let quote = '';
  const endWord = () => { if (has) words.push(word); word = ''; has = false; };
  const endSeg = () => { endWord(); if (words.length) segments.push(words); words = []; };
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (quote === "'") {
      if (c === "'") quote = ''; else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && n !== undefined) { word += n; i++; }
      else if (c === '`' || (c === '$' && n === '(')) { flags.add('substitution'); word += c; }
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\') {
      if (n === '\n') { i++; continue; }
      if (n !== undefined) { word += n; has = true; i++; }
      continue;
    }
    if (c === '#' && !has) { while (i < s.length && s[i] !== '\n') i++; i--; continue; } // comment
    if (c === '`') { flags.add('substitution'); continue; }
    if (c === '$' && n === '(') { flags.add('substitution'); word += c; has = true; continue; }
    if (c === '|') { if (n === '|') { endSeg(); i++; } else { flags.add('pipe'); endSeg(); } continue; }
    if (c === '&') {
      if (n === '&') { endSeg(); i++; continue; }
      if (n === '>') flags.add('redirect'); else flags.add('background');
      endSeg();
      continue;
    }
    if (c === ';' || c === '\n') { endSeg(); continue; }
    if (c === '>' || c === '<') { flags.add('redirect'); endWord(); continue; }
    if (c === '(' || c === ')') { flags.add('subshell'); endSeg(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
    word += c; has = true;
  }
  if (quote) flags.add('unterminated');
  endSeg();
  return { segments, flags };
}

// ---------------------------------------------------------------- matching

const COMPOUND = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'function', 'select', '{', '}', '!', '[[', 'coproc']);
// Words in command position that end, replace or interact with the shell. The
// wrapper needs the shell to reach its tail, and an interactive command's
// prompt would go into a file nobody reads.
const SHELL_WORDS = new Set(['exit', 'exec', 'trap', 'eval', 'sudo', 'ssh', 'read', 'watch', 'return', 'break', 'continue',
  'tee', 'less', 'more', 'vim', 'vi', 'nano', 'top', 'htop']);
// Flags that mean the output is read by something else, or the run never
// ends: leave the command exactly as written.
const BLOCK_FLAG = /^(--watch(All|-all|man)?(=.*)?|--interactive|-it|-ti|--json|-json|--message-format(=.*)?|--format(=.*)?|--porcelain|--collect-only|--co|--list|--list-tests|--listTests|--reporter=(json|tap|junit)|--junitxml=-|--outputFile.*|--version|--help|-h|--dry-run)$/;

const TEST_SCRIPT = /^(test|tests|build|lint|typecheck|type-check|tsc|check|e2e|ci|coverage|compile|verify|bundle|prepare|install)([:_.-].*)?$/;
const JS_PM = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npm.cmd', 'pnpm.cmd', 'yarn.cmd']);
const JS_PM_VERBS = new Set(['test', 't', 'tst', 'it', 'cit', 'ci', 'install', 'i', 'add', 'update', 'up', 'upgrade', 'rebuild', 'build', 'dedupe']);
const JS_EXEC = new Set(['vitest', 'jest', 'mocha', 'ava', 'tap', 'jasmine', 'playwright', 'cypress', 'tsc', 'eslint', 'webpack', 'rollup',
  'vite', 'next', 'nx', 'turbo', 'nuxt', 'astro', 'quasar', 'ng', 'expo', 'wrangler', 'prettier', 'stylelint', 'svelte-kit', 'tsup', 'esbuild']);
// Runners that are long whatever their arguments.
const DIRECT = new Set(['vitest', 'jest', 'mocha', 'ava', 'tap', 'jasmine', 'pytest', 'py.test', 'tox', 'nox', 'behave', 'rspec', 'phpunit',
  'make', 'gmake', 'ninja', 'ctest', 'msbuild', 'xcodebuild', 'bazel', 'sbt', 'gradle', 'gradlew', 'mvn', 'mvnw', 'ant', 'tsc', 'eslint',
  'webpack', 'ruff', 'mypy', 'pyright', 'golangci-lint', 'shellcheck', 'flake8', 'pylint', 'rubocop', 'clippy-driver']);
// Runners that are long only for some sub-commands (first non-flag argument).
const WITH_VERB = {
  cargo: new Set(['test', 'build', 'check', 'clippy', 'install', 'nextest', 'bench', 'doc', 'fetch', 'update']),
  go: new Set(['test', 'build', 'vet', 'install', 'generate', 'mod', 'get']),
  dotnet: new Set(['test', 'build', 'restore', 'publish', 'pack']),
  flutter: new Set(['test', 'build', 'analyze', 'pub']),
  dart: new Set(['test', 'analyze', 'compile', 'pub']),
  swift: new Set(['build', 'test']),
  mix: new Set(['test', 'compile', 'deps.get']),
  bundle: new Set(['install', 'exec', 'update']),
  composer: new Set(['install', 'update', 'require']),
  pip: new Set(['install', 'download', 'wheel']),
  pip3: new Set(['install', 'download', 'wheel']),
  poetry: new Set(['install', 'update', 'build']),
  uv: new Set(['sync', 'pip', 'build', 'lock']),
  conda: new Set(['install', 'create', 'update']),
  docker: new Set(['build', 'buildx', 'pull']),
  podman: new Set(['build', 'pull']),
  rake: new Set(['test', 'spec', 'build']),
  lein: new Set(['test', 'deps', 'uberjar']),
  cmake: new Set(['--build']),
  node: new Set(['--test']),
  deno: new Set(['test', 'check']),
  brew: new Set(['install', 'upgrade', 'update']),
  winget: new Set(['install', 'upgrade']),
  choco: new Set(['install', 'upgrade']),
};
const PY = new Set(['python', 'python3', 'py', 'python.exe']);
const PY_MODULES = new Set(['pytest', 'unittest', 'pip', 'tox', 'nox', 'coverage', 'build', 'mypy', 'ruff']);

function baseName(w) {
  const t = String(w).replace(/\\/g, '/').split('/').pop();
  return t.replace(/\.(exe|cmd|bat|sh)$/i, '').toLowerCase();
}
const firstNonFlag = (args) => args.find((a) => !a.startsWith('-'));

// Drop what can sit in front of the real command: VAR=value, env, time,
// command, nice, timeout <duration>.
function stripPrefix(words) {
  let w = words.slice();
  for (;;) {
    if (!w.length) return w;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { w = w.slice(1); continue; }
    const b = baseName(w[0]);
    if (b === 'env' || b === 'time' || b === 'command' || b === 'nice') { w = w.slice(1); continue; }
    if (b === 'timeout' && w.length > 2) { w = w.slice(2); continue; }
    return w;
  }
}

// The runner label for one simple command (its words), or null.
export function runnerOf(words) {
  const w = stripPrefix(words);
  if (!w.length) return null;
  const cmd = baseName(w[0]);
  const args = w.slice(1);
  if (JS_PM.has(cmd) || JS_PM.has(w[0])) {
    const name = cmd.replace(/\.cmd$/, '');
    const verb = firstNonFlag(args);
    if (!verb) return null;
    if (verb === 'run' || verb === 'run-script') {
      const script = firstNonFlag(args.slice(args.indexOf(verb) + 1));
      return script && TEST_SCRIPT.test(script) ? `${name} run ${script}` : null;
    }
    if (verb === 'exec' || verb === 'dlx' || verb === 'x') {
      const tool = firstNonFlag(args.slice(args.indexOf(verb) + 1));
      return tool && JS_EXEC.has(baseName(tool)) ? `${name} ${verb} ${baseName(tool)}` : null;
    }
    if (JS_PM_VERBS.has(verb)) return `${name} ${verb}`;
    // yarn/pnpm/bun run a package script by its bare name: `pnpm test:unit`.
    if (name !== 'npm' && TEST_SCRIPT.test(verb)) return `${name} ${verb}`;
    return null;
  }
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') {
    const tool = firstNonFlag(args);
    return tool && JS_EXEC.has(baseName(tool)) ? `${cmd} ${baseName(tool)}` : null;
  }
  if (PY.has(cmd)) {
    const mi = args.indexOf('-m');
    const mod = mi >= 0 ? args[mi + 1] : undefined;
    return mod && PY_MODULES.has(mod) ? `python -m ${mod}` : null;
  }
  if (cmd === 'playwright' || cmd === 'cypress') return args[0] === 'test' || args[0] === 'run' ? cmd : null;
  if (WITH_VERB[cmd]) {
    const verbs = WITH_VERB[cmd];
    if (cmd === 'node' || cmd === 'cmake') return args.some((a) => verbs.has(a)) ? `${cmd} ${[...verbs][0]}` : null;
    const verb = firstNonFlag(args);
    return verb && verbs.has(verb) ? `${cmd} ${verb}` : null;
  }
  if (DIRECT.has(cmd)) return cmd;
  return null;
}

// Analyze one command line. { runner, blockers }: wrap only when there is a
// runner and no blocker. `runner` is set even when blocked, so the hook can
// record which known long-runners it had to leave alone, and why.
export function analyze(command) {
  const blockers = [];
  if (typeof command !== 'string' || !command.trim()) return { runner: null, blockers: ['empty'] };
  const { segments, flags } = lex(command);
  let runner = null;
  for (const seg of segments) {
    const r = runnerOf(seg);
    if (r && !runner) runner = r;
  }
  if (!runner) return { runner: null, blockers: [] };
  for (const f of ['pipe', 'redirect', 'background', 'substitution', 'subshell', 'unterminated']) {
    if (flags.has(f)) blockers.push(f);
  }
  for (const seg of segments) {
    const body = stripPrefix(seg);
    if (!body.length) continue;
    const first = body[0];
    if (COMPOUND.has(first)) { blockers.push('compound'); break; }
    const fb = baseName(first);
    if (SHELL_WORDS.has(fb) || (fb === 'set' && /^[-+]/.test(body[1] || ''))) { blockers.push(`shell-word:${fb}`); break; }
  }
  for (const seg of segments) {
    if (seg.some((a) => BLOCK_FLAG.test(a))) { blockers.push('output-flag'); break; }
  }
  return { runner, blockers: [...new Set(blockers)] };
}

// ---------------------------------------------------------------- the wrapper

// A POSIX single-quoted string.
export function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Forward slashes: Git Bash takes `C:/Users/x` everywhere, and a backslash
// path would be eaten by the shell's own quoting rules.
export function shellPath(p) { return String(p).replace(/\\/g, '/'); }

export function wrapCommand(command, { file, dir, resultLog = '', id = '' }) {
  const f = shq(file);
  const d = shq(dir);
  const log = resultLog
    ? `printf '{"v":2,"at":"%s","event":"result","id":"%s","rc":%s,"lines":%s,"bytes":%s,"shown_chars":%s,"truncated":%s}\\n' ` +
      `"$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${shq(id)} "$__acrc" "$__acn" "$__acb" "$__acsc" "$__actr" >> ${shq(resultLog)} 2>/dev/null`
    : ':';
  return [
    `__acf=${f}`,
    `if mkdir -p ${d} 2>/dev/null && : > "$__acf" 2>/dev/null; then`,
    `{ ${command}`,
    `} > "$__acf" 2>&1`,
    '__acrc=$?',
    `__acn=$(wc -l < "$__acf" | tr -d ' ')`,
    `__acb=$(wc -c < "$__acf" | tr -d ' ')`,
    `if [ "$__acn" -le ${FULL_MAX_LINES} ] && [ "$__acb" -le ${FULL_MAX_BYTES} ]; then`,
    'cat "$__acf"; rm -f "$__acf"; __acsc=$__acb; __actr=0',
    'else',
    `if [ "$__acrc" -ne 0 ]; then __ack=${TAIL_FAILED_LINES}; else __ack=${TAIL_PASSED_LINES}; fi`,
    '__acp=$(cygpath -m "$__acf" 2>/dev/null || printf \'%s\' "$__acf")',
    `__acs=$(printf '[ac-bash-tail] exit %s; %s lines, %s bytes of output; last %s lines below. Full output (grep or Read it): %s\\n' "$__acrc" "$__acn" "$__acb" "$__ack" "$__acp"; tail -n "$__ack" "$__acf" | cut -c1-${LINE_CUT_CHARS})`,
    'printf \'%s\\n\' "$__acs"; __acsc=${#__acs}; __actr=1',
    'fi',
    log,
    '(exit "$__acrc")',
    'else',
    `${command}`,
    'fi',
  ].join('\n');
}

// Where the full-output files go, and a name for this run.
export function outputTarget(env = process.env) {
  const dir = shellPath(env.AGENT_COMPANION_BASH_TAIL_DIR || join(tmpdir(), 'ac-bash-tail'));
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  return { dir, id, file: `${dir}/${id}.log` };
}

// Best effort, bounded: files older than KEEP_FILES_MS go. Never throws.
export function pruneOldOutputs(dir, now = Date.now(), maxEntries = 300) {
  try {
    mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const name of readdirSync(dir)) {
      if (++n > maxEntries) break;
      if (!name.endsWith('.log')) continue;
      const p = join(dir, name);
      try { if (now - statSync(p).mtimeMs > KEEP_FILES_MS) unlinkSync(p); } catch { /* skip */ }
    }
  } catch { /* fail open */ }
}

// The permission modes in which the rewrite is applied. Claude Code runs
// permission checks on the REWRITTEN command (verified in the 2.1.283 binary),
// and a wrapped command no longer matches a `Bash(npm test:*)` allow rule, so
// outside bypassPermissions it could turn an allowed command into a prompt (or
// a denial, in a headless run). "any" lifts the limit.
export function modeAllowed(mode, setting) {
  const raw = String(setting ?? 'bypassPermissions').trim();
  if (/^(any|all|\*)$/i.test(raw)) return true;
  const list = raw.split(/[\s,]+/).filter(Boolean);
  return list.includes(String(mode ?? ''));
}
