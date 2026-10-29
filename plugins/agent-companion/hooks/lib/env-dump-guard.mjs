// env_dump_guard (0.31.25): deny commands that print environment VALUES in bulk, and commands that print a
// secret-named variable. Called from hooks/poll-guard.mjs on Bash and PowerShell (no extra process).
//
// Incident, 2026-10-17: `env | grep -i claude` printed the value of CLAUDE_CODE_MESSAGING_TOKEN into a transcript
// that session-sync uploads to Google Drive.
//
// Denied (a real command segment, not quoted text or a grep pattern):
//   bulk dumps: bare `env` / `printenv` / `set` / `export` / `export -p` / `declare` / `declare -x|-p` / `typeset`,
//     `env | grep ...`, PowerShell `Get-ChildItem env:` (also gci, ls, dir, Get-Item, gi on env: or env:*),
//     `[Environment]::GetEnvironmentVariables()`, `cat|strings|tr /proc/<pid>/environ`
//   secret prints: `printenv NAME`, `echo $NAME` / `echo "${NAME}"` (also printf, print, cat), PowerShell `$env:NAME`
//     alone or in Write-Host / Write-Output / echo, `Get-Item env:NAME`, `gc env:NAME`, where NAME has a part TOKEN, KEY,
//     SECRET, PASSWORD, PASSWD, AUTH, CREDENTIAL or COOKIE. In Bash only an UPPER_CASE name counts (a loop variable
//     named $key is not an environment secret); PowerShell env names are case-insensitive.
// Allowed: any of the above followed in the same pipeline by a names-only or count-only filter (`env | cut -d= -f1`,
//   `printenv | sed 's/=.*//'`, `... | awk -F= '{print $1}'`, `grep -o '^[^=]*'`, `wc`, `grep -q|-c`, a checksum), stdout
//   redirected to a file, `compgen -e`, `(Get-ChildItem env:).Name`, `[Environment]::GetEnvironmentVariables().Keys`,
//   `env FOO=1 cmd` (runs a command), `set -e`, `export FOO=1`, `${NAME:+x}` and `[ -n "$NAME" ]` presence tests,
//   `$(env)` captured into an assignment, and a `$NAME` used as an argument of any other command (curl -H ... $TOKEN).
// Inline programs (env-dump-inline.mjs): the code of `node -e|-p`, `python -c`, `deno eval`, `bun -e`, and a program or
//   shell script fed on stdin (a heredoc, `<<<`, `cat <<E |`, `echo '...' |`, a PowerShell string or here-string piped
//   in), `powershell -EncodedCommand`, judged by the same two kinds. Stdout or stderr counts only where it reaches the
//   transcript: `> file` covers stdout, `2> file` stderr, `&> file` both (a bare `2>/dev/null` no longer hides stdout).
// A redirection to the screen is not a file (0.31.28): /dev/stdout, /dev/stderr, /dev/tty, /dev/fd/1|2, /proc/self/fd/1|2,
//   a process substitution `>(...)`, PowerShell `CON`, and the stream merges `>&2`, `*>&1`, so `env > /dev/stdout` is denied.

import { parseCommands, baseName, psParam, progIndex } from './process-kill-guard.mjs';
import { inlinePrograms, judgeProgram } from './env-dump-inline.mjs';

const MAX_DEPTH = 6;
const BUDGET = 400000;
const SECRET_PART = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE)|(^|_)(KEY|O?AUTH|AUTHORIZATION)(_|$)|[A-Z0-9]KEY(_|$)/i;

export const ENV_MSG =
  'This command would print environment variable VALUES (a bulk dump, or a variable named like a secret: TOKEN, KEY, SECRET, ' +
  'PASSWORD, PASSWD, AUTH, CREDENTIAL, COOKIE) into the transcript, and session-sync uploads transcripts (2026-10-17: ' +
  '`env | grep -i claude` put CLAUDE_CODE_MESSAGING_TOKEN in a transcript that went to Google Drive). List NAMES only: ' +
  '`env | cut -d= -f1`, `printenv | sed \'s/=.*//\'`, `compgen -e`, in PowerShell `(Get-ChildItem env:).Name`, in node ' +
  '`Object.keys(process.env)`, in Python `sorted(os.environ)`. To check that a ' +
  'value is present without printing it: `[ -n "$NAME" ] && echo set || echo unset` (PowerShell: `if ($env:NAME) { \'set\' } ' +
  'else { \'unset\' }`); to use a secret, pass it as an argument or on stdin and never echo it. To switch this guard off or to a ' +
  'warning, set the plugin option env_dump_guard to off or warn.';

const isSecretName = (name, shell) => {
  if (!name) return false;
  if (shell !== 'powershell' && !/^[A-Z][A-Z0-9_]*$/.test(name)) return false;
  return SECRET_PART.test(name);
};

const PREFIX = new Set(['exec', 'command', 'builtin', 'nohup', 'time', 'setsid', 'nice', 'stdbuf', 'call', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
const PRINTERS = new Set(['echo', 'printf', 'print', 'write-host', 'write-output', 'write-information', 'out-host']);

// the program word of a simple command WITHOUT looking through `env` (bare `env` is the dump)
function rawProg(words) {
  let k = 0;
  while (k < words.length) {
    const a = words[k].t;
    const b = baseName(a);
    if (!words[k].q && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { k++; continue; }
    if (PREFIX.has(b)) { k++; continue; }
    if (b === 'sudo') {
      k++;
      while (k < words.length && words[k].t[0] === '-' && words[k].t.length > 1) k += /^(-u|-g|-h|-p|-C|-D|-R|-T|-U)$/.test(words[k].t) ? 2 : 1;
      continue;
    }
    return k;
  }
  return -1;
}

// a redirection target that is the screen, not a file: /dev/stdout, /dev/stderr, /dev/tty, /dev/fd/1|2,
// /proc/self/fd/1|2, a terminal device, a process substitution `>(...)` (the parser leaves its `>` as the target word),
// and the Windows console device CON / CONOUT$
const TO_SCREEN = /^(?:\/dev\/(?:stdout|stderr|tty|console|fd\/[12]|pts\/\d+)|\/proc\/self\/fd\/[12]|con:?|conout\$|>(?:\(.*)?)$/i;

// where stdout (1) and stderr (2) go: to a file (true) or on to the transcript / the pipe (false). errToOut: 2>&1 while
// stdout was not yet a file, so stderr follows stdout down the pipe.
function redirState(words) {
  const r = { 1: false, 2: false, errToOut: false };
  for (let j = 0; j < words.length; j++) {
    const x = words[j];
    if (x.q) continue;
    const m = /^(&|\*|\d*)(>>?|>\|)(&?)([\s\S]*)$/.exec(x.t);
    if (!m) continue;
    const [, fd, , dup, rest] = m;
    if (dup) { // n>&m: 2>&1 follows stdout; 1>&2 and >&2 stay on screen
      if (fd === '2' && rest === '1') { if (r[1]) r[2] = true; else r.errToOut = true; }
      continue;
    }
    let target = rest;
    if (target === '' && j + 1 < words.length) target = words[++j].t; // operator alone: its target is the next word
    if (TO_SCREEN.test(target)) continue;
    if (fd === '&' || fd === '*') { r[1] = true; r[2] = true; } // &>f, PowerShell *>f
    else if (fd === '' || fd === '1') r[1] = true;
    else if (fd === '2') r[2] = true;
  }
  return r;
}
const redirected = (words) => redirState(words)[1];

// argument words without redirections: in `env 2>/dev/null` or `printenv > f`, the redirection is not an argument
function noRedir(words) {
  const out = [];
  for (let j = 0; j < words.length; j++) {
    const x = words[j];
    if (!x.q && /^(\d*|&|\*)(<<<|>>?|>\||<)$/.test(x.t)) { j++; continue; } // operator alone: its target is the next word
    if (!x.q && /^(\d*|&|\*)(>>?|>\||<(?![<(]))/.test(x.t)) continue;
    out.push(x);
  }
  return out;
}
// programs that print what a here-string feeds them
const HERE_ECHO = new Set(['cat', 'tee', 'tr', 'head', 'tail', 'sort', 'uniq', 'rev', 'base64', 'xxd', 'od', 'sed', 'awk', 'gawk', 'grep', 'xargs', 'tac', 'fold', 'nl', 'paste']);

// split an `env -S` string into words the way env does: whitespace separates, '...' and "..." group (quotes dropped)
function splitEnvString(str) {
  const out = [];
  let buf = '';
  let started = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length) { buf += str[++i]; started = true; continue; }
    if (c === "'" || c === '"') {
      const e = str.indexOf(c, i + 1);
      const end = e < 0 ? str.length : e;
      buf += str.slice(i + 1, end);
      started = true;
      i = end;
      continue;
    }
    if (/\s/.test(c)) { if (started) { out.push(buf); buf = ''; started = false; } continue; }
    buf += c; started = true;
  }
  if (started) out.push(buf);
  return out;
}
// the `-S` option at word j of an env argument list: { str, used } or null; matches -S STR, -SSTR, -iS STR, --split-string=STR
function envSplitAt(ws, j) {
  const a = ws[j].t;
  const sm = /^--split-string(?:=([\s\S]*))?$/.exec(a) || /^-[i0v]*S([\s\S]*)$/.exec(a);
  if (!sm) return null;
  const inline = sm[1] !== undefined && sm[1] !== '';
  return { str: inline ? sm[1] : (ws[j + 1] ? ws[j + 1].t : ''), used: inline ? 1 : 2 };
}
const shq = (t) => `'${String(t).replace(/'/g, "'\\''")}'`;
// `env ... -S STRING ...` as command text: the string stays shell text (so quotes, nested shells, eval, xargs and inline
// programs inside it are judged by a full scan), every other word is single-quoted. null when env has no -S.
function envSplitText(words, k) {
  const rest = noRedir(words.slice(k + 1));
  const parts = [];
  let found = false;
  let j = 0;
  while (j < rest.length) {
    const a = rest[j].t;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { parts.push(shq(a)); j++; continue; }
    if (a === '--') { parts.push(shq(a)); j++; break; }
    const sp = envSplitAt(rest, j);
    if (sp) { found = true; parts.push(sp.str); j += sp.used; continue; }
    if (a.length > 1 && a[0] === '-') {
      const n = /^-(u|C|-unset|-chdir)$/.test(a) ? 2 : 1;
      for (let q = 0; q < n && j < rest.length; q++, j++) parts.push(shq(rest[j].t));
      continue;
    }
    break;
  }
  if (!found) return null;
  for (; j < rest.length; j++) parts.push(shq(rest[j].t));
  return 'env ' + parts.join(' ');
}

// kind of an env source command: 'dump' | 'secret' | null
function classify(cmd, shell) {
  const w = cmd.words;
  const k = rawProg(w);
  if (k < 0) return null;
  const prog = baseName(w[k].t);
  const rest = noRedir(w.slice(k + 1));
  const args = rest.map((x) => x.t);
  const ps = shell === 'powershell';
  if (w.some((x) => /getenvironmentvariables\(/i.test(x.t))) {
    return w.some((x) => /getenvironmentvariables\([^)]*\)\.keys\b/i.test(x.t)) ? null : 'dump';
  }
  // a PowerShell expression alone on its line prints its value; a redirection after it (`$env:NAME > CON`) is not a word
  const lone = ps ? noRedir(w) : w;
  if (lone.length === 1 && ps && /^\$\{?env:\w+\}?$/i.test(lone[0].nv ?? lone[0].t)) {
    return isSecretName(/env:(\w+)/i.exec(lone[0].t)[1], 'powershell') ? 'secret' : null;
  }
  if (lone.length === 1 && ps && /getenvironmentvariable\(\s*['"]?\w+/i.test(lone[0].t)) {
    const m = /getenvironmentvariable\(\s*['"]?(\w+)/i.exec(lone[0].t);
    return m && isSecretName(m[1], 'powershell') ? 'secret' : null;
  }
  // PowerShell: a quoted first word ('text', "text", a here-string) is a string value, not a command; it prints itself,
  // so only a $env:NAME expanded inside a double-quoted one counts. After the call operator (`& 'C:\...\env.exe'`,
  // `$x = & "...\printenv.exe"`) or a dot-source (`. 'C:\...\env.exe'`) the quoted word is the program, judged below.
  if (ps && w[k].q && !cmd.call) {
    const re = /\$\{?env:(\w+)\}?/gi;
    let m;
    while ((m = re.exec(w[k].nv ?? ''))) if (isSecretName(m[1], 'powershell')) return 'secret';
    return null;
  }
  // bash here-string into a program that prints its input: cat <<< "$TOKEN"
  // and an unquoted heredoc into one: bash expands its body like a double-quoted word (cat <<E / $TOKEN / E)
  if (!ps && HERE_ECHO.has(prog) && !(prog === 'grep' && args.some((a) => /^-[A-Za-z]*[qcl]/.test(a)))) {
    const expandsSecret = (text, honorBackslash) => {
      const re = /(\\?)\$(?:\{([A-Za-z_]\w*)(?![\w])([^}]*)\}|([A-Za-z_]\w*))/g;
      let m;
      while ((m = re.exec(text))) {
        if (m[1] && honorBackslash) continue;
        if (m[2] !== undefined ? !/^:?\+/.test(m[3] || '') && isSecretName(m[2], shell) : isSecretName(m[4], shell)) return true;
      }
      return false;
    };
    const h = w.findIndex((x) => !x.q && x.t === '<<<');
    if (h >= 0 && w[h + 1] && expandsSecret(w[h + 1].nv ?? w[h + 1].t, false)) return 'secret';
    const bodies = cmd.heredocs || [];
    for (let j = 0; j < bodies.length; j++) if (cmd.hereQuoted?.[j] === false && expandsSecret(bodies[j], true)) return 'secret';
  }

  if (prog === 'env') {
    // `env -S STRING` splits STRING into words (also -SSTRING, -iS STRING, --split-string=STRING): those words are options,
    // NAME=value words or the command, as if written out. A command that follows is judged as that command.
    const ws = rest.slice();
    let j = 0;
    while (j < ws.length) {
      const a = ws[j].t;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { j++; continue; }
      if (a === '--') { j++; break; }
      const sp = envSplitAt(ws, j);
      if (sp) {
        ws.splice(j, sp.used, ...splitEnvString(sp.str).map((t) => ({ t, q: false })));
        continue;
      }
      if (a.length > 1 && a[0] === '-') { j += /^-(u|C|-unset|-chdir)$/.test(a) ? 2 : 1; continue; }
      break;
    }
    if (j >= ws.length) return 'dump';
    return classify({ ...cmd, words: ws.slice(j) }, shell);
  }
  if (!ps && (prog === 'awk' || prog === 'gawk' || prog === 'mawk' || prog === 'nawk')) {
    // an awk program that prints the ENVIRON array: `for (k in ENVIRON) print k, ENVIRON[k]`, print ENVIRON["API_KEY"]
    const code = args.filter((a) => a[0] !== '-').join(' ');
    if (/\bENVIRON\b/.test(code) && /\bprint(f)?\b/.test(code)) {
      const idx = [...code.matchAll(/\bENVIRON\s*\[\s*([^\]]*?)\s*\]/g)].map((m) => m[1]);
      const lit = idx.map((x) => /^"([^"]*)"$/.exec(x) || /^'([^']*)'$/.exec(x));
      if (/\bin\s+ENVIRON\b/.test(code) || lit.some((m) => !m)) return 'dump';
      return lit.some((m) => isSecretName(m[1], shell)) ? 'secret' : null;
    }
  }
  if (prog === 'printenv') {
    const names = args.filter((a) => a[0] !== '-');
    if (!names.length) return 'dump';
    return names.some((n) => isSecretName(n, shell)) ? 'secret' : null;
  }
  if (!ps && prog === 'set') return args.length === 0 ? 'dump' : null;
  if (!ps && prog === 'export') {
    return args.length === 0 || args.every((a) => /^-[A-Za-z]*p[A-Za-z]*$/.test(a)) ? 'dump' : null;
  }
  if (!ps && (prog === 'declare' || prog === 'typeset')) {
    const names = args.filter((a) => a[0] !== '-');
    const flags = args.filter((a) => a[0] === '-').join('');
    if (!names.length) return !args.length || /[xp]/.test(flags) ? 'dump' : null;
    if (/p/.test(flags) && names.some((n) => isSecretName(n, shell))) return 'secret';
    return null;
  }
  if (ps && ['get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi', 'get-content', 'gc', 'cat', 'type'].includes(prog)) {
    let target = null;
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      let v = null;
      if (psParam(a, [['path', 1], ['literalpath', 1]])) {
        const c = a.indexOf(':');
        v = c > 0 && !/^-\w+:?$/.test(a) ? a.slice(c + 1) : args[j + 1];
        if (c > 0 && /^-\w+:$/.test(a)) v = args[j + 1];
      } else if (a[0] !== '-') v = a;
      if (v && /^env:/i.test(v)) { target = v.replace(/^env:[\\/]?/i, ''); break; }
    }
    if (target == null) return null;
    if (target === '' || /[*?]/.test(target)) return /^[*?]*$/.test(target) || !isSecretName(target.replace(/[*?]/g, ''), 'powershell') ? 'dump' : 'secret';
    return isSecretName(target, 'powershell') ? 'secret' : null;
  }
  if (['cat', 'strings', 'tr', 'xargs', 'head', 'less', 'more', 'od', 'xxd'].includes(prog) && w.some((x) => /\/proc\/[^/\s]+\/environ(?![\w.-])/.test(x.t))) return 'dump';

  if (PRINTERS.has(prog)) {
    const re = /\$\{?env:(\w+)\}?|\$(?:\{([A-Za-z_]\w*)(?![\w])([^}]*)\}|([A-Za-z_]\w*))/g;
    for (const x of rest) {
      const text = x.nv ?? x.t;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        if (m[1] !== undefined) { if (isSecretName(m[1], 'powershell')) return 'secret'; } // $env:NAME
        else if (m[2] !== undefined) { // ${NAME...}: ${NAME:+x} and ${NAME+x} are presence tests, not the value
          if (/^:?\+/.test(m[3] || '')) continue;
          if (isSecretName(m[2], shell)) return 'secret';
        } else if (m[4] !== undefined && isSecretName(m[4], shell)) return 'secret';
      }
    }
  }
  return null;
}

// `s/=.*//` drops the value. A non-empty replacement (`s/=.*/=.../`) is as safe while it cannot re-emit what
// the match held and the delimiter cannot make sed split the script somewhere else than this pattern does: the
// delimiter is one of / | , : @ % ~ # (never = . * $ or a letter); the replacement has no `&`, no backslash (so
// no \1, \0 or other escape), no `$` or backtick (a double-quoted script is expanded by the shell first), no
// delimiter, no control character (the tokenizer leaves a NUL where a `$(...)` stood), one line; and the flags are only g, I, i (not `e`, which runs the line, nor `w`, which writes it).
const isSedNames = (a) => /^s(.)=\.\*\$?\1\1[a-z]*$/.test(a) || /^s([/|,:@%~#])=\.\*\$?\1((?:(?!\1)[^&\\$`\x00-\x1f])*)\1[gIi]*$/.test(a);

// does a downstream command keep values off the transcript (names only, a count, a hash, a quiet test)?
function isFilter(cmd, shell) {
  const w = cmd.words;
  const k = rawProg(w);
  if (k < 0) return false;
  const prog = baseName(w[k].t);
  const args = w.slice(k + 1).map((x) => x.t);
  const joined = args.join(' ');
  if (prog === 'cut') {
    const delim = args.some((a) => a === '-d=' || a === '--delimiter==') || args.some((a, i) => (a === '-d' || a === '--delimiter') && args[i + 1] === '=');
    const field = args.some((a) => a === '-f1' || a === '--fields=1') || args.some((a, i) => (a === '-f' || a === '--fields') && args[i + 1] === '1');
    return delim && field;
  }
  if (prog === 'sed') return args.some(isSedNames);
  if (prog === 'awk' || prog === 'gawk') return /-F\s*=/.test(joined) && /\{\s*print\s+\$1\s*\}/.test(joined);
  if (prog === 'grep' || prog === 'egrep' || prog === 'rg') {
    if (args.some((a) => /^-[A-Za-z]*[qcl][A-Za-z]*$/.test(a) || a === '--quiet' || a === '--count' || a === '--files-with-matches')) return true;
    return args.some((a) => /^-[A-Za-z]*o[A-Za-z]*$/.test(a) || a === '--only-matching') && args.some((a) => /^\^?\[\^=\]\*?$/.test(a));
  }
  if (['wc', 'sha1sum', 'sha256sum', 'sha512sum', 'md5sum', 'cksum', 'b2sum'].includes(prog)) return true;
  if (shell === 'powershell') {
    if (['measure-object', 'measure', 'out-null'].includes(prog)) return true;
    if (['select-object', 'select', 'foreach-object', '%', 'foreach', 'format-table', 'ft', 'format-list', 'fl', 'sort-object', 'sort', 'where-object', '?'].includes(prog)) {
      return false; // handled by the name-only test in the chain pass, which looks at every downstream command at once
    }
  }
  return false;
}

// Programs whose standard output reaches the transcript when they end a pipeline.
const ECHOING = new Set(['cat', 'tee', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'gawk', 'head', 'tail', 'sort', 'uniq', 'tr', 'cut', 'xargs',
  'echo', 'printf', 'less', 'more', 'od', 'xxd', 'hexdump', 'base64', 'rev', 'fold', 'paste', 'nl', 'column', 'jq', 'yq', 'fmt', 'tac', 'strings',
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'eval', 'select', 'foreach', '%', '?', 'where', 'sort', 'iex']);

// `echo $SECRET | docker login --password-stdin`: the value goes to a consumer, not to the transcript.
// Judged by the last command of the pipeline; unknown or printing programs keep the deny.
function consumedQuietly(down) {
  if (!down.length) return false;
  const last = down[down.length - 1];
  const k = rawProg(last.words);
  if (k < 0) return false;
  const prog = baseName(last.words[k].t).toLowerCase();
  if (ECHOING.has(prog) || /^(out|format|write|convertto|convertfrom|select|foreach|where|sort|tee|get|invoke)-/.test(prog)) return false;
  return true;
}

// PowerShell names-only projection somewhere downstream: mentions Name / Key and never Value
function psNamesOnly(downstream) {
  const text = downstream.map((c) => c.words.map((x) => x.t).join(' ')).join(' ');
  if (/value/i.test(text)) return false;
  return downstream.some((c) => {
    const k = rawProg(c.words);
    if (k < 0) return false;
    const prog = baseName(c.words[k].t);
    const mentions = c.words.some((x, i) => i > k && /(^|[.\s,$])(name|key)s?$/i.test(x.t.replace(/^-expandproperty$/i, '')) && !/^-/.test(x.t))
      || c.words.some((x, i) => i > k && /(?:^|[\s.{$_])(name|key)\b/i.test(x.t) && !/^-/.test(x.t));
    return mentions && ['select-object', 'select', 'foreach-object', '%', 'foreach', 'format-table', 'ft', 'format-list', 'fl', 'write-output', 'echo'].includes(prog)
      || (c.words.length === 1 && /^\$_\.(name|key)s?$/i.test(c.words[0].t));
  });
}

// The code of an inline program (env-dump-inline.mjs). A hit counts only on a stream that reaches the transcript:
// stdout is safe when redirected to a file, piped to a names-only / count filter, or (a secret) into a quiet consumer;
// stderr when redirected to a file, or sent down that same safe pipe by 2>&1.
function inlineHits(c, list, i, shell, depth, st, hits) {
  if (depth >= MAX_DEPTH) return;
  const progs = inlinePrograms(c, i > 0 ? list[i - 1] : null, shell);
  if (!progs.length) return;
  const down = list.slice(i + 1);
  const red = redirState(c.words);
  const nested = (text) => { const h = { env: null }; scan(text, 'bash', depth + 1, st, h); return h.env ? h.env.split(':')[0] : null; };
  for (const p of progs) {
    if (p.lang === 'bash' || p.lang === 'powershell') { scan(p.code, p.lang, depth + 1, st, hits); if (hits.env) return; continue; }
    const r = judgeProgram(p.lang, p.code, p.printLast, nested);
    if (!r) continue;
    // 2>&1 sends stderr where stdout pointed at that moment (the pipe), so a later `> file` does not cover it
    const pipeSafe = down.some((d) => isFilter(d, shell)) || (r.kind === 'secret' && consumedQuietly(down));
    const safe1 = red[1] || pipeSafe;
    const safe2 = red[2] || (red.errToOut && pipeSafe);
    if ([...r.streams].every((s) => (s === 1 ? safe1 : safe2))) continue;
    const pk = progIndex(c.words);
    hits.env = `${r.kind}: ${pk >= 0 && pk < c.words.length ? baseName(c.words[pk].t).slice(0, 40) : ''}`;
    return;
  }
}

// skipTop: the commands of this text are the inside of an `env -S` string; the outer command already ran classify on it
// (with the pipeline filters around it), so only the nested shells, eval, xargs and inline programs are judged here.
function scan(text, shell, depth, st, hits, skipTop = false) {
  if (depth > MAX_DEPTH) return;
  const cmds = parseCommands(text, shell, depth, st);
  const byChain = new Map();
  for (const c of cmds) {
    if (!byChain.has(c.chain)) byChain.set(c.chain, []);
    byChain.get(c.chain).push(c);
  }
  // sub commands whose result is only captured or only has its names read are not printed
  for (const c of cmds) {
    const k = rawProg(c.words);
    if (k < 0) for (const sc of c.subs) sc.captured = true; // VAR=$(...) with no command
    if (c.words.some((x) => /^\u0000\.(name|key)s?$/i.test(x.t))) for (const sc of c.subs) sc.captured = true; // (Get-ChildItem env:).Name
  }
  for (const c of cmds) {
    if (c.words.length && /^(if|elseif|while|until|switch|!|-not)$/i.test(c.words[0].t)) for (const sc of c.subs) sc.condition = true;
  }
  for (const list of byChain.values()) {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.captured) continue;
      const kind = skipTop ? null : classify(c, shell);
      if (kind === 'secret' && c.condition) continue; // if (\$env:NAME) { ... }: a presence test
      if (kind && !redirected(c.words)) {
        const down = list.slice(i + 1);
        const safe = down.some((d) => isFilter(d, shell)) || (shell === 'powershell' && kind === 'dump' && psNamesOnly(down))
          || (kind === 'secret' && consumedQuietly(down));
        // the detail is the kind and the program word only: never a word of the command (an inline literal could be a secret)
        if (!safe) { const pk = rawProg(c.words); hits.env = hits.env || `${kind}: ${pk >= 0 ? baseName(c.words[pk].t).slice(0, 40) : ''}`; }
      }
      // inline programs: node -e, python -c, a heredoc into node / python / bash / pwsh, pwsh -EncodedCommand
      if (!hits.env) inlineHits(c, list, i, shell, depth, st, hits);
      // nested scripts
      let k = rawProg(c.words);
      if (k < 0) continue;
      // env as a prefix: `env -S "bash -c env"` (the string is shell text, scanned in full one level deeper);
      // `env [-i] [NAME=v] bash -c env` runs the program after env's own words
      if (baseName(c.words[k].t) === 'env') {
        const split = envSplitText(c.words, k);
        if (split !== null) {
          scan(split, shell, depth + 1, st, hits, true);
          continue;
        }
        const pk = progIndex(c.words);
        if (pk > k && pk < c.words.length) k = pk; else continue;
      }
      const prog = baseName(c.words[k].t);
      const args = c.words.slice(k + 1).map((x) => x.t);
      let nested = null;
      if (prog === 'xargs') {
        // the command xargs runs: the first word that is not an option (or an option's value)
        let a = 0;
        while (a < args.length && args[a][0] === '-' && args[a].length > 1) a += /^-[IneEsLPdaiSl]$/.test(args[a]) ? 2 : 1;
        if (a < args.length) nested = [args.slice(a).join(' '), shell];
      } else if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(prog)) {
        const ci = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
        if (ci >= 0 && args[ci + 1] !== undefined) nested = [args[ci + 1], 'bash'];
      } else if (prog === 'powershell' || prog === 'pwsh') {
        const ci = args.findIndex((a) => psParam(a, [['command', 1]]) || a.toLowerCase() === '-c');
        if (ci >= 0 && args[ci + 1] !== undefined) nested = [args.slice(ci + 1).join(' '), 'powershell'];
      } else if (prog === 'cmd') {
        const ci = args.findIndex((a) => /^[/-]{1,2}[ck]$/i.test(a));
        if (ci >= 0 && args[ci + 1] !== undefined) nested = [args.slice(ci + 1).join(' '), 'bash'];
      } else if (prog === 'eval') nested = [args.join(' '), shell];
      else if (prog === 'invoke-expression' || prog === 'iex') nested = [args.join(' '), 'powershell'];
      if (nested) scan(nested[0], nested[1], depth + 1, st, hits);
    }
  }
}

/** Returns { env: string|null }. Never throws: any failure allows. */
export function envDumpHits(command, shell = 'bash') {
  try {
    const cmd = String(command || '');
    if (!cmd || cmd.length > 200000) return { env: null };
    const hits = { env: null };
    scan(cmd, shell === 'powershell' ? 'powershell' : 'bash', 0, { nextChain: 0, steps: 0 }, hits);
    return hits;
  } catch { return { env: null }; }
}

/** Hook entry: { kind: 'env-dump', message, mode, detail } or null. opts.mode is deny|warn|off. */
export function envDumpGuard(payload, opts = {}) {
  const mode = String(opts.mode ?? 'deny').toLowerCase();
  if (mode === 'off') return null;
  const command = payload?.tool_input?.command;
  const shell = payload?.tool_name === 'PowerShell' ? 'powershell' : 'bash';
  const r = envDumpHits(command, shell);
  if (!r.env) return null;
  return { kind: 'env-dump', message: ENV_MSG, mode: mode === 'warn' ? 'warn' : 'deny', detail: r.env };
}
