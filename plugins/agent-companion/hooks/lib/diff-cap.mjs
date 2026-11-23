// Diff cap (0.31.66): one `git diff`, `git show` or `git log -p` call puts no more than DIFF_CAP_LINES lines of diff into context.
// Four of six workers that hit the 150K context cap had 23-47K Bash results, mostly diff output. Same budget as the shell-read hook
// (hooks/bash-read.mjs: nudge at 300 lines, deny at 400), but fixed silently: the command is rewritten (hooks/bash-tail.mjs, step 1b) so
// its full output goes to a file; up to DIFF_CAP_LINES lines print as they are, more prints the stat, the first DIFF_SHOW_LINES lines and
// the file's path, to read the rest by range (Read offset/limit). The command's exit status is kept.
//
// Left alone: a diff that is not a patch (--stat, --name-only, --name-status, --quiet, --exit-code, --shortstat, --numstat, --check,
// --no-patch, -s), output that is redirected, piped, backgrounded or substituted, a `git show <rev>:<path>` file read (the read-budget
// hook's job), and everything that is not git diff/show/log (git apply, patch). An explicit -p/--patch/-u wins over a stat flag.
// Pure: no I/O. The hook supplies the file path.
import { lex, shq } from './bash-tail.mjs';

export const DIFF_CAP_LINES = 400;
export const DIFF_SHOW_LINES = 300;
export const DIFF_CAP_BYTES = 40000; // a few very long lines (minified files, binary patches) are over the cap too
export const DIFF_STAT_LINES = 40;

// What the wrapper adds besides the original command, as it appears in the generated text (permission rules are matched against these).
export const DIFF_CAP_HELPERS = [
  ': > "$__adf"', 'wc -l < "$__adf"', 'wc -c < "$__adf"', 'cat "$__adf"', 'rm -f "$__adf"', 'git apply --stat "$__adf"',
  `head -n ${DIFF_STAT_LINES}`, `head -n ${DIFF_SHOW_LINES} "$__adf"`, `head -c ${DIFF_CAP_BYTES}`, 'printf \'...\'', 'exit "$__adrc"',
];

const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const PATCH_FLAG = /^(-p|-u|--patch|--patch-with-stat|--patch-with-raw|--cc)$/;
const NO_PATCH_FLAG = /^(--stat(=.*)?|--name-only|--name-status|--quiet|-q|--exit-code|--shortstat|--numstat|--dirstat(=.*)?|--summary|--raw|--check|--no-patch|-s|--output(=.*)?|-h|--help)$/;

// { sub: 'diff'|'show'|'log' } when the command is ONE capped-diff command (after any leading `cd`s); else null.
export function diffCapTarget(command) {
  if (typeof command !== 'string' || !/\bgit\b/.test(command) || !/\b(diff|show|log)\b/.test(command)) return null;
  const { segments, flags } = lex(command);
  if (flags.size || !segments.length) return null;
  for (let i = 0; i < segments.length - 1; i += 1) if (segments[i][0] !== 'cd') return null;
  const words = segments[segments.length - 1];
  if (words[0] !== 'git') return null;
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    i += GLOBAL_WITH_VALUE.has(w) ? 2 : 1;
  }
  const sub = words[i];
  if (sub !== 'diff' && sub !== 'show' && sub !== 'log') return null;
  const args = [];
  for (const w of words.slice(i + 1)) { if (w === '--') break; args.push(w); }
  const explicit = args.some((a) => PATCH_FLAG.test(a));
  if (sub === 'log' && !explicit) return null; // a log prints no patch unless asked
  if (!explicit && args.some((a) => NO_PATCH_FLAG.test(a))) return null;
  if (explicit && args.some((a) => /^(-h|--help|--output(=.*)?|--quiet|-q|--exit-code)$/.test(a))) return null;
  if (sub === 'show' && args.some((a) => !a.startsWith('-') && /^[^\s]*:[^\s]+$/.test(a) && !/^[A-Za-z]:[\\/]/.test(a))) return null; // rev:path
  return { sub };
}

// The wrapped command text: runs `command` as written into `file`, prints it whole when short, else the stat, the head and the path.
export function diffCapWrap(command, { file }) {
  const f = shq(file);
  return [
    `__adf=${f}`,
    'if case $- in *[eC]*) false;; *) :;; esac && : > "$__adf" 2>/dev/null; then',
    `{ ${command}`,
    '} > "$__adf" 2>&1',
    '__adrc=$?',
    '__adn=$(( $(wc -l < "$__adf") ))',
    '__adb=$(( $(wc -c < "$__adf") ))',
    `if [ "$__adn" -le ${DIFF_CAP_LINES} ] && [ "$__adb" -le ${DIFF_CAP_BYTES} ]; then`,
    'cat "$__adf"; rm -f "$__adf"',
    'else',
    `printf '[ac-diff-cap] %s lines, %s bytes of diff: the stat of all of it, then the first ${DIFF_SHOW_LINES} lines.\\n' "$__adn" "$__adb"`,
    `git apply --stat "$__adf" 2>/dev/null | head -n ${DIFF_STAT_LINES}`,
    `head -n ${DIFF_SHOW_LINES} "$__adf" | head -c ${DIFF_CAP_BYTES}`,
    `printf '\\n[ac-diff-cap] cut here. The rest is in %s: Read(file_path="%s", offset=${DIFF_SHOW_LINES + 1}, limit=${DIFF_SHOW_LINES}), then the next range; or narrow the call with a path (git diff -- <path>).\\n' "$__adf" "$__adf"`,
    'fi',
    '(exit "$__adrc")',
    'else',
    `${command}`,
    'fi',
  ].join('\n');
}
