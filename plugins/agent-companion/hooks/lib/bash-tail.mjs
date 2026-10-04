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
// The wrapper is bash (the Bash tool's shell: Git Bash on Windows, bash, zsh):
//   - one line naming the full-output path is printed BEFORE the command
//     runs, so a run killed by the tool's timeout still says where its output is;
//   - the original command runs inside `{ ...; }` (NOT a subshell), so `cd`
//     and variable changes still reach the shell the tool tracks;
//   - if errexit (`set -e`) is already on, the ORIGINAL command runs as written:
//     a failing wrapped command would end the shell before it printed anything;
//   - the exit status is captured at once and re-raised with `(exit N)`, so
//     the tool sees exactly the status the command had;
//   - output of 80 lines / 8000 bytes or less is printed whole (nothing to
//     save, nothing hidden) and the file removed;
//   - above that: a header with exit code, size and the full-output path, then
//     the last 60 lines of a FAILED run or the last 20 of a passing one. A
//     failed run also gets up to 5 summary-looking lines (failed, passed,
//     Tests:, ERR!) from EARLIER in the file, for runners that print the
//     summary first. The tail is capped at TAIL_MAX_CHARS characters, keeping
//     the END (a single huge line shows its last part, not its first 1000);
//   - if the output file cannot be created, the ORIGINAL command runs as it
//     was written (the if/else below), so wrapping can never stop a command.
// The helper commands the wrapper adds are few on purpose (WRAPPER_HELPERS):
// permission deny/ask rules are matched against the rewritten text, so the
// hook reads those rules and leaves a command alone when one could match.

import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { mkdirSync, readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const FULL_MAX_LINES = 80;
export const FULL_MAX_BYTES = 8000;
export const TAIL_FAILED_LINES = 60;
export const TAIL_PASSED_LINES = 20;
export const TAIL_MAX_CHARS = 10000;
export const SUMMARY_MAX_LINES = 5;
export const SUMMARY_LINE_CHARS = 300;
export const KEEP_FILES_MS = 3 * 24 * 60 * 60 * 1000;
export const TELEMETRY_STREAM = 'bash-tail.jsonl';
// Matches the usual "how did it go" lines of test runners and package managers.
export const SUMMARY_PATTERN = 'FAIL|[Ff]ailed|[Ff]ailing|[Pp]assed|[Pp]assing|Tests:|Test Suites:|ERR!|SUMMARY|[Ss]ummary';

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
// `source` and `.` can switch errexit on INSIDE the command (`source env.sh &&
// npm test` with a `set -e` in env.sh): a failing run would then end the shell
// before the wrapper printed anything, and `$-` cannot see that in advance.
const SHELL_WORDS = new Set(['exit', 'exec', 'trap', 'eval', 'sudo', 'ssh', 'read', 'watch', 'return', 'break', 'continue',
  'tee', 'less', 'more', 'vim', 'vi', 'nano', 'top', 'htop', 'source', '.']);
// Flags that mean the output is read by something else, or the run never
// ends or waits for a person: leave the command exactly as written.
// `-w` is every tool's watch short flag (tsc, mocha, rollup, vitest); where it
// means something else (`jest -w 4`, `npm i -w pkg`) leaving the command alone
// only costs the saving.
const BLOCK_FLAG = /^(--watch(All|-all|man)?(=.*)?|-w|--ui(=.*)?|--serve|--interactive|-it|-ti|--json|-json|--message-format(=.*)?|--format(=.*)?|--porcelain|--collect-only|--co|--list|--list-tests|--listTests|--reporter=(json|tap|junit)|--junitxml(=.*)?|--junit-xml(=.*)?|--outputFile.*|--version|--help|-h|--dry-run)$/;

// Output-format flags in the separate-argument form (`--reporter json`,
// `-f json`, `--coverageReporters=json`): a tail of JSON or XML is useless and
// the run's summary is not in it.
const FORMAT_KEY = /^(--reporter|--reporters|--format|--formatter|--output-format|--out-format|--report-format|--message-format|--coverageReporters|--coverage-reporters|-f|-R)$/;
const FORMAT_VALUE = /^((nd)?json(l|-.*)?|xml|junit(-?xml)?|tap|sarif|checkstyle|teamcity)$/i;
function machineFormat(args) {
  for (let i = 0; i < args.length; i++) {
    const m = /^(-{1,2}[A-Za-z][A-Za-z-]*)=(.*)$/.exec(args[i]);
    const key = m ? m[1] : args[i];
    const val = m ? m[2] : args[i + 1];
    if (FORMAT_KEY.test(key) && typeof val === 'string' && val.split(',').some((v) => FORMAT_VALUE.test(v))) return true;
  }
  return false;
}

const TEST_SCRIPT = /^(test|tests|build|lint|typecheck|type-check|tsc|check|e2e|ci|coverage|compile|verify|bundle|prepare|install)([:_.-].*)?$/;
// A package script whose name says it watches, serves or waits for a person.
const LONG_SCRIPT = /(^|[:_.-])(watch|ui|serve|server|headed|interactive|debug|open|storybook)([:_.-]|$)/i;
const JS_PM = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npm.cmd', 'pnpm.cmd', 'yarn.cmd']);
const JS_PM_VERBS = new Set(['test', 't', 'tst', 'it', 'cit', 'ci', 'install', 'i', 'add', 'update', 'up', 'upgrade', 'rebuild', 'build', 'dedupe']);
// Tools run through npx / pnpm dlx / pnpm exec / bunx, or directly.
//   JS_EXEC     every tool we recognise (so the label and a `skipped` row exist);
//   TOOL_VERBS  tools with dev servers or watchers: ONLY these sub-commands are
//               one-shot runs. Anything else (`vite`, `vite preview`, `next dev`,
//               `wrangler login`, `playwright codegen`, `cypress open`) is left alone;
//   TOOL_SERVE  one-shot tools that have a few server/watch sub-commands.
// The same tables decide `vite` and `npx vite`, so they cannot disagree.
const TOOL_VERBS = {
  vite: ['build', 'optimize'], next: ['build', 'lint'], nx: ['build', 'test', 'lint', 'typecheck'],
  turbo: ['build', 'test', 'lint', 'typecheck', 'check', 'type-check', 'run'], nuxt: ['build', 'generate', 'typecheck', 'prepare'],
  astro: ['build', 'check', 'sync'], quasar: ['build'], ng: ['build', 'lint', 'extract-i18n'],
  expo: ['export', 'prebuild', 'install', 'doctor'], wrangler: ['deploy', 'publish', 'types', 'versions'],
  'svelte-kit': ['build', 'sync', 'check'], playwright: ['test', 'install', 'merge-reports'], cypress: ['run', 'install', 'verify'],
};
const TOOL_SERVE = { vitest: ['watch', 'dev'], webpack: ['serve', 'server', 's', 'watch', 'w'] };
const JS_EXEC = new Set(['vitest', 'jest', 'mocha', 'ava', 'tap', 'jasmine', 'tsc', 'eslint', 'webpack', 'rollup',
  'prettier', 'stylelint', 'tsup', 'esbuild', ...Object.keys(TOOL_VERBS)]);
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
  // A tool with dev servers or watchers, run directly (`vite build`, `playwright test`).
  if (TOOL_VERBS[cmd]) return toolNeverEnds(cmd, args) ? null : cmd;
  if (WITH_VERB[cmd]) {
    const verbs = WITH_VERB[cmd];
    if (cmd === 'node' || cmd === 'cmake') return args.some((a) => verbs.has(a)) ? `${cmd} ${[...verbs][0]}` : null;
    const verb = firstNonFlag(args);
    return verb && verbs.has(verb) ? `${cmd} ${verb}` : null;
  }
  if (DIRECT.has(cmd)) return cmd;
  return null;
}

// A one-shot test/build tool that also has server or watch sub-commands, or a
// dev-server tool whose only one-shot sub-commands are listed in TOOL_VERBS.
// `args` are the arguments after the tool name. Returns a reason or null.
function toolNeverEnds(tool, args) {
  const verb = firstNonFlag(args);
  if (TOOL_SERVE[tool]) return verb && TOOL_SERVE[tool].includes(verb) ? `${tool} ${verb}` : null;
  const allowed = TOOL_VERBS[tool];
  if (!allowed) return null;
  if (!verb || !allowed.includes(verb)) return verb ? `${tool} ${verb}` : tool;
  if (tool === 'turbo' && verb === 'run') {
    const script = firstNonFlag(args.slice(args.indexOf(verb) + 1));
    if (!script || !TEST_SCRIPT.test(script) || LONG_SCRIPT.test(script)) return `turbo run ${script || ''}`.trim();
  }
  return null;
}

const SERVE_TARGET = /^(run|serve|server|dev|start|watch|up|debug|shell|repl|demo|preview|live|run[-_:.]\S*|\S*[-_:.](run|serve|server|dev|watch|start))$/;
const SERVE_TASK = /^(~.*|--continuous|run|bootRun|bootTestRun|runClient|runServer|appRun|jettyRun|quarkusDev|start|serve|dev|debug|exec:java|exec:exec)$|:(run|bootRun|bootTestRun|dev|serve|start|debug|watch)$/;

// Does this simple command never exit by itself, or wait for a person? (A dev
// server, a watcher, an interactive login, a debugger.) Its startup output is
// the whole point and a tail would hide it. Returns a short reason or null.
export function neverEnds(words) {
  const w = stripPrefix(words);
  if (!w.length) return null;
  const cmd = baseName(w[0]);
  const args = w.slice(1);
  const first = firstNonFlag(args);
  if (first && /^(login|logout|signin|auth|authenticate)$/.test(first)) return `interactive:${first}`;
  if (JS_PM.has(cmd) || JS_PM.has(w[0])) {
    const name = cmd.replace(/\.cmd$/, '');
    if (!first) return null;
    if (first === 'run' || first === 'run-script') {
      const script = firstNonFlag(args.slice(args.indexOf(first) + 1));
      return script && LONG_SCRIPT.test(script) ? `script:${script}` : null;
    }
    if (first === 'exec' || first === 'dlx' || first === 'x') {
      const rest = args.slice(args.indexOf(first) + 1);
      const tool = firstNonFlag(rest);
      return tool ? toolNeverEnds(baseName(tool), rest.slice(rest.indexOf(tool) + 1)) : null;
    }
    if (first === 'start' || first === 'restart' || first === 'dev') return `server:${name} ${first}`;
    if (name !== 'npm' && LONG_SCRIPT.test(first)) return `script:${first}`;
    return null;
  }
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') {
    return first ? toolNeverEnds(baseName(first), args.slice(args.indexOf(first) + 1)) : null;
  }
  const isPytest = cmd === 'pytest' || cmd === 'py.test'
    || (PY.has(cmd) && args.indexOf('-m') >= 0 && args[args.indexOf('-m') + 1] === 'pytest');
  if (isPytest && args.some((a) => /^(-f|--looponfail|--pdb|--pdbcls(=.*)?|--trace)$/.test(a))) return 'interactive:pytest';
  if (cmd === 'make' || cmd === 'gmake') {
    const t = args.find((a) => !a.startsWith('-') && SERVE_TARGET.test(a));
    return t ? `target:${t}` : null;
  }
  if (['gradle', 'gradlew', 'mvn', 'mvnw', 'sbt', 'bazel', 'ant'].includes(cmd)) {
    const t = args.find((a) => SERVE_TASK.test(a) || ((cmd === 'gradle' || cmd === 'gradlew') && a === '-t'));
    return t ? `task:${t}` : null;
  }
  if (TOOL_VERBS[cmd] || TOOL_SERVE[cmd]) return toolNeverEnds(cmd, args);
  return null;
}

// Commands that may sit beside a runner in a chain without changing whether
// the chain ends: they print little and exit. Anything else next to a runner
// is unknown (it could be a server: `npm install && node server.js`), so the
// whole chain is left alone.
const HARMLESS = new Set(['cd', 'pushd', 'popd', 'echo', 'printf', 'export', 'unset', 'true', 'false', ':', 'pwd', 'ls', 'cat',
  'mkdir', 'rm', 'cp', 'mv', 'touch', 'git', 'date', 'which', 'test', '[']);

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
  // EVERY segment must be a one-shot runner or harmless: one server or watcher
  // anywhere in a chain (`npm install && npm run dev`) and nothing is wrapped.
  for (const seg of segments) {
    const body = stripPrefix(seg);
    if (!body.length) continue;
    const ne = neverEnds(seg);
    if (ne) { blockers.push(`never-ends:${ne}`); continue; }
    if (!runnerOf(seg) && !HARMLESS.has(baseName(body[0])) && !COMPOUND.has(body[0])
      && !SHELL_WORDS.has(baseName(body[0])) && baseName(body[0]) !== 'set') blockers.push(`other-command:${baseName(body[0])}`);
  }
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
    if (seg.some((a) => BLOCK_FLAG.test(a)) || machineFormat(seg)) { blockers.push('output-flag'); break; }
  }
  return { runner, blockers: [...new Set(blockers)] };
}

// ---------------------------------------------------------------- the wrapper

// A POSIX single-quoted string.
export function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Forward slashes: Git Bash takes `C:/Users/x` everywhere, and a backslash
// path would be eaten by the shell's own quoting rules.
export function shellPath(p) { return String(p).replace(/\\/g, '/'); }

// The commands the wrapper adds (besides the user's own), written the way
// they appear in the generated text. Permission deny/ask rules are matched
// against the rewritten command, so blockingPermissionRule() tests every rule
// against these. A test fails if the wrapper starts using a command that is
// not named here.
export const WRAPPER_HELPERS = [
  ': > "$__acf"', 'wc -l < "$__acf"', 'wc -c < "$__acf"', 'cat "$__acf"', 'rm -f "$__acf"',
  'tail -n "$__ack" "$__acf"', `grep -n -m ${SUMMARY_MAX_LINES} -E '${SUMMARY_PATTERN}' "$__acf"`,
  'printf \'%s\\n\' "$__acs"', 'printf \'[ac-bash-tail] full output ...\' "$__acf"', 'date -u +%Y-%m-%dT%H:%M:%SZ',
  'read -r __acl', 'exit "$__acrc"', '[ "$__acn" -le 80 ]',
];

export function wrapCommand(command, { file, dir, resultLog = '', id = '' }) {
  void dir; // the hook creates the directory (pruneOldOutputs); the wrapper does not call mkdir
  const f = shq(file);
  const log = resultLog
    ? `printf '{"v":2,"at":"%s","event":"result","id":"%s","rc":%s,"lines":%s,"bytes":%s,"shown_chars":%s,"truncated":%s}\\n' ` +
      `"$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${shq(id)} "$__acrc" "$__acn" "$__acb" "$__acsc" "$__actr" >> ${shq(resultLog)} 2>/dev/null`
    : ':';
  return [
    `__acf=${f}`,
    // errexit already on: the original runs as written (see the header comment).
    'if case $- in *e*) false;; *) :;; esac && : > "$__acf" 2>/dev/null; then',
    // Before the command runs: a run killed by the tool timeout still names its file.
    `printf '[ac-bash-tail] full output of this run goes to %s (deleted again if the run prints ${FULL_MAX_LINES} lines or fewer)\\n' "$__acf"`,
    `{ ${command}`,
    '} > "$__acf" 2>&1',
    '__acrc=$?',
    '__acn=$(( $(wc -l < "$__acf") ))',
    '__acb=$(( $(wc -c < "$__acf") ))',
    `if [ "$__acn" -le ${FULL_MAX_LINES} ] && [ "$__acb" -le ${FULL_MAX_BYTES} ]; then`,
    'cat "$__acf"; rm -f "$__acf"; __acsc=$__acb; __actr=0',
    'else',
    `if [ "$__acrc" -ne 0 ]; then __ack=${TAIL_FAILED_LINES}; else __ack=${TAIL_PASSED_LINES}; fi`,
    '__act=$(tail -n "$__ack" "$__acf")',
    // Cap by characters and keep the END: one huge line shows its last part.
    `if [ "\${#__act}" -gt ${TAIL_MAX_CHARS} ]; then`,
    `__act="[ac-bash-tail] tail cut to its last ${TAIL_MAX_CHARS} characters`,
    `\${__act: -${TAIL_MAX_CHARS}}"`,
    'fi',
    // A failed run: summary-looking lines from EARLIER in the file, for runners that print the summary first.
    "__acm=''",
    'if [ "$__acrc" -ne 0 ]; then',
    'while IFS= read -r __acl; do',
    `if [ "\${__acl%%:*}" -le "$(( __acn - __ack ))" ] 2>/dev/null; then __acm="$__acm`,
    `\${__acl:0:${SUMMARY_LINE_CHARS}}"; fi`,
    `done <<< "$(grep -n -m ${SUMMARY_MAX_LINES} -E '${SUMMARY_PATTERN}' "$__acf" 2>/dev/null)"`,
    'fi',
    '__acs="[ac-bash-tail] exit $__acrc; $__acn lines, $__acb bytes of output; last $__ack lines below. Full output (grep or Read it): $__acf"',
    'if [ -n "$__acm" ]; then __acs="$__acs',
    '[ac-bash-tail] summary-looking lines from earlier in the file (line:text):$__acm"; fi',
    '__acs="$__acs',
    '$__act"',
    'printf \'%s\\n\' "$__acs"; __acsc=${#__acs}; __actr=1',
    'fi',
    log,
    '(exit "$__acrc")',
    'else',
    `${command}`,
    'fi',
  ].join('\n');
}

// ---------------------------------------------------------------- permission rules

// Claude Code matches deny and ask rules against the REWRITTEN command, in
// every permission mode (bypassPermissions included), and a rule matches when
// any simple command inside it does, even inside `if`/`{ }` bodies. So the
// wrapper's own helper commands (rm, tail, grep, printf ...) and its
// redirects can trip a user's `Bash(rm *)` rule, and a rule meant for the
// original command might not see it inside the group. The hook therefore
// reads the deny and ask rules and leaves a command alone when any of them
// could match either the original command or a helper. Over-cautious by
// design: leaving a command alone only costs the saving.
// stopAt: the home directory. The walk up from cwd stops before it, because
// its .claude/ IS the user scope (claudeDirPath) and a fixture's walk must not
// reach the real home.
export function readPermissionRules({ cwd, claudeDirPath, projectDir, managedPaths = [], stopAt } = {}) {
  const files = [];
  if (claudeDirPath) files.push(join(claudeDirPath, 'settings.json'), join(claudeDirPath, 'settings.local.json'));
  const roots = [];
  if (projectDir) roots.push(resolve(projectDir));
  if (cwd) {
    let d = resolve(cwd);
    const stop = stopAt ? resolve(stopAt) : null;
    for (let i = 0; i < 64; i++) {
      if (stop && (process.platform === 'win32' ? d.toLowerCase() === stop.toLowerCase() : d === stop)) break;
      roots.push(d);
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  for (const r of roots) files.push(join(r, '.claude', 'settings.json'), join(r, '.claude', 'settings.local.json'));
  files.push(...managedPaths);
  const rules = [];
  for (const file of new Set(files)) {
    let obj;
    try { obj = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const kind of ['deny', 'ask']) {
      const list = obj?.permissions?.[kind];
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        const m = typeof s === 'string' ? /^Bash(?:\(([\s\S]*)\))?$/.exec(s.trim()) : null;
        if (m) rules.push({ kind, pattern: (m[1] ?? '').trim(), rule: s, file });
      }
    }
  }
  return rules;
}

function globMatch(pattern, text) {
  const legacy = pattern.endsWith(':*'); // `Bash(npm test:*)`: a prefix match
  const body = legacy ? pattern.slice(0, -2) : pattern;
  const re = body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*');
  return new RegExp(`^${re}${legacy ? '(\\s[\\s\\S]*)?' : ''}$`).test(text);
}

// The first deny/ask rule that could match the original command (whole, or any
// of its simple commands) or one of WRAPPER_HELPERS; null when none could.
export function blockingPermissionRule(rules, command) {
  if (!rules || !rules.length) return null;
  const { segments } = lex(command);
  const texts = [String(command).trim(), ...segments.map((w) => w.join(' ')), ...segments.map((w) => stripPrefix(w).join(' '))];
  for (const r of rules) {
    const pat = r.pattern;
    if (pat === '' || /^[*:\s]+$/.test(pat)) return r; // `Bash` or `Bash(*)`: every command
    if (/[<>]/.test(pat)) return r; // a rule about redirects: the wrapper adds redirects
    if (WRAPPER_HELPERS.some((h) => globMatch(pat, h)) || texts.some((t) => globMatch(pat, t))) return r;
  }
  return null;
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
// a denial, in a headless run). "any" lifts the limit. This is about ALLOW
// rules. Deny and ask rules apply in EVERY mode, bypassPermissions included,
// and are handled separately: see readPermissionRules / blockingPermissionRule.
export function modeAllowed(mode, setting) {
  const raw = String(setting ?? 'bypassPermissions').trim();
  if (/^(any|all|\*)$/i.test(raw)) return true;
  const list = raw.split(/[\s,]+/).filter(Boolean);
  return list.includes(String(mode ?? ''));
}
