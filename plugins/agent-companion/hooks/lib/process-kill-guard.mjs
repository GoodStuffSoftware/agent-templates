// Two Bash / PowerShell command denies, called from hooks/poll-guard.mjs (no extra process):
//
//  1. kill_by_name_guard (0.31.25): killing processes by image name or filter instead of by PID. On a shared machine
//     the name matches processes other sessions own (2026-09-24: `taskkill /F /IM node.exe /T` killed every node
//     process including the pm2 daemon and voided every green in that window; 2026-10-16: `/IM java.exe` killed other
//     sessions' emulators). Denied: taskkill without /PID (or with /IM, or /FI IMAGENAME), pkill, killall,
//     Stop-Process -Name / -ProcessName, Get-Process <name> piped to Stop-Process / kill / .Kill(), wmic process
//     where <not processid> delete|terminate, Get-CimInstance / Get-WmiObject Win32_Process filtered by anything but
//     ProcessId and piped to Terminate / Remove-CimInstance / Invoke-CimMethod, and `kill` or `taskkill /PID` fed by a
//     pgrep / pidof (or Get-Process <name>) substitution or `pgrep ... | xargs kill`.
//     Allowed: taskkill /PID n, kill n, Stop-Process -Id n, and any lookup that does not kill.
//  2. plugin uninstall: `claude plugin uninstall` (also remove / rm), in any spelling. Always denied, no switch: any
//     uninstall deletes the plugin's data directory and the CLI one also wipes pluginConfigs (2026-09-12, 2026-09-18).
//
// Only real command segments are judged. One linear pass splits the command into simple commands (quotes, escapes,
// comments, heredoc bodies, $(..), backticks and PowerShell (..) groups are followed or skipped as data), so text in a
// quoted argument to echo / grep / git commit is never a command. `bash -c`, `sh -c`, `powershell -Command`, `pwsh`,
// `cmd /c`, `eval` and `Invoke-Expression` strings, and a shell fed by a heredoc, are parsed again as commands.
// Any exception or an exhausted step budget allows (fail-open, like the other guards in this hook).

const MAX_DEPTH = 6;
const BUDGET = 400000;

export const KILL_MSG =
  'Never kill a process by image name or filter (taskkill /IM, taskkill without /PID, pkill, killall, Stop-Process -Name, ' +
  'Get-Process <name> | Stop-Process, a wmic / CIM delete filtered by name, kill $(pgrep ...)): on this shared machine the name ' +
  'matches processes other sessions own (a taskkill /F /IM node.exe once killed every node process, the pm2 daemon included, ' +
  'and voided every green in that window). Instead: 1. find the PID (Get-CimInstance Win32_Process -Filter "Name=\'x.exe\'" | ' +
  'Select ProcessId, ParentProcessId, CommandLine; or tasklist; or ps); 2. confirm the process is yours by walking its parent ' +
  'chain (ParentProcessId, up) to a process you started or to your own session, and check its command line names your worktree; ' +
  '3. kill that PID only: taskkill /PID <pid> (from Git Bash: taskkill //PID <pid>), kill <pid>, or Stop-Process -Id <pid>. ' +
  'A process you did not start is stopped only after that check. To switch this guard off or to a warning, set the plugin ' +
  'option kill_by_name_guard to off or warn.';

export const UNINSTALL_MSG =
  'Plugins are never removed through the CLI on this machine: any uninstall deletes the plugin data directory, and `claude plugin ' +
  'uninstall` also wipes pluginConfigs (the plugin options and spawn telemetry were lost this way on 2026-09-12 and 2026-09-18). ' +
  'Supported paths: to refresh a stale copy, run `claude plugin marketplace update <marketplace>`, then `claude plugin update ' +
  '<plugin>@<marketplace>`, then verify one user-scope record at the new sha in installed_plugins.json (CONTRIBUTING.md, ' +
  '"Install a release"); to clear a stale desktop copy or a stale entry, disable then re-enable (or remove the stale entry) in the ' +
  'desktop app\'s plugin manager, then start a fresh session; to turn a plugin off, `claude plugin disable`. This deny has no switch.';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PS_SHELLS = new Set(['powershell', 'pwsh']);
const PS_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// ---------------------------------------------------------------------------------------------------------------------
// Tokenizer: text -> simple commands. Each command: { words: [{ t, q }], subs: [command], chain, heredocs: [string] }.
// `chain` is a statement id (changes at ; && || newline and & at brace depth 0), so a pipeline can be recognised as
// "commands in one chain, in order".

export function parseCommands(text, shell, depth, st) {
  const out = [];
  if (depth > MAX_DEPTH) return out;
  const ps = shell === 'powershell';
  const s = String(text);
  const n = s.length;
  let i = 0;
  let chain = st.nextChain++;
  let depthBrace = 0;
  let words = [];
  let subs = [];
  let heredocs = [];
  let buf = '';
  let started = false;
  let quoted = false;
  const pendingHere = [];

  const endWord = () => {
    if (started) words.push({ t: buf.replace(/\u0001/g, '$'), nv: buf, q: quoted });
    buf = ''; started = false; quoted = false;
  };
  const endCmd = () => {
    endWord();
    // bash reserved braces are not commands
    if (!ps) while (words.length && (words[0].t === '{' || words[0].t === '}' || words[0].t === '!') && !words[0].q) words.shift();
    if (words.length || subs.length) out.push({ words, subs, chain, heredocs });
    words = []; subs = []; heredocs = [];
  };
  const newChain = () => { if (depthBrace === 0) chain = st.nextChain++; };
  const sub = (inner) => {
    const cs = parseCommands(inner, shell, depth + 1, st);
    for (const c of cs) { out.push(c); subs.push(c); }
    return cs;
  };
  // index just past the matching closer for an opener at s[open]; quote aware; -1 when unbalanced
  const matchClose = (open, oc, cc) => {
    let d = 0;
    const pend = []; // heredoc delimiters waiting for the next newline (bash only): their bodies are data
    for (let j = open; j < n; j++) {
      if (++st.steps > BUDGET) throw new Error('budget');
      const c = s[j];
      if (!ps && c === '<' && s[j + 1] === '<' && s[j + 2] !== '<') {
        const hm = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_]+))/.exec(s.slice(j, j + 200));
        if (hm) { pend.push({ word: hm[2] ?? hm[3] ?? hm[4], dash: hm[1] === '-' }); j += hm[0].length - 1; continue; }
      }
      if (c === '\n' && pend.length) {
        let p = j + 1;
        while (pend.length) {
          const h = pend.shift();
          while (p < n) {
            if (++st.steps > BUDGET) throw new Error('budget');
            let e = s.indexOf('\n', p);
            if (e < 0) e = n;
            const line = s.slice(p, e).replace(/\r$/, '');
            p = Math.min(n, e + 1);
            if ((h.dash ? line.replace(/^\t+/, '') : line) === h.word) break;
          }
        }
        j = p - 1;
        continue;
      }
      if (c === '\\' && !ps) { j++; continue; }
      if (c === '`' && ps) { j++; continue; }
      if (c === "'") { const e = s.indexOf("'", j + 1); if (e < 0) return -1; j = e; continue; }
      if (c === '"') {
        for (j++; j < n; j++) {
          if (s[j] === '\\' && !ps) { j++; continue; }
          if (s[j] === '`' && ps) { j++; continue; }
          if (s[j] === '"') { if (ps && s[j + 1] === '"') { j++; continue; } break; }
        }
        continue;
      }
      if (c === oc) d++;
      else if (c === cc) { d--; if (d === 0) return j + 1; }
    }
    return -1;
  };

  while (i < n) {
    if (++st.steps > BUDGET) throw new Error('budget');
    const c = s[i];
    if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') { i++; }
      endCmd();
      newChain();
      i++;
      // heredoc bodies start on the next line
      while (pendingHere.length) {
        const h = pendingHere.shift();
        const lines = [];
        let found = false;
        while (i < n) {
          let e = s.indexOf('\n', i);
          if (e < 0) e = n;
          let line = s.slice(i, e).replace(/\r$/, '');
          i = Math.min(n, e + 1);
          const cmp = h.dash ? line.replace(/^\t+/, '') : line;
          if (cmp === h.delim) { found = true; break; }
          lines.push(line);
        }
        h.list.push(lines.join('\n'));
        void found;
      }
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '#' && !started) { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === "'") {
      const e = (() => {
        let j = i + 1;
        for (; j < n; j++) {
          if (s[j] === "'") { if (ps && s[j + 1] === "'") { j++; continue; } break; }
        }
        return j;
      })();
      let seg = s.slice(i + 1, Math.min(e, n));
      if (ps) seg = seg.replace(/''/g, "'");
      buf += seg.replace(/\$/g, '\u0001'); started = true; quoted = true; // nv: a '$' in single quotes is not a variable reference
      i = e + 1;
      continue;
    }
    if (c === '"') {
      started = true; quoted = true;
      i++;
      while (i < n) {
        if (++st.steps > BUDGET) throw new Error('budget');
        const d = s[i];
        if (d === '"') { if (ps && s[i + 1] === '"') { buf += '"'; i += 2; continue; } i++; break; }
        if (d === '\\' && !ps) {
          const nx = s[i + 1];
          if (nx !== undefined && '$`"\\\n'.includes(nx)) { if (nx === '$') buf += '\u0001'; else if (nx !== '\n') buf += nx; i += 2; continue; }
          buf += d; i++; continue;
        }
        if (d === '`' && ps) { if (i + 1 < n) buf += s[i + 1]; i += 2; continue; }
        if (d === '$' && s[i + 1] === '(' && s[i + 2] !== '(') {
          const e = matchClose(i + 1, '(', ')');
          if (e < 0) { buf += d; i++; continue; }
          sub(s.slice(i + 2, e - 1));
          buf += '\u0000'; i = e; continue;
        }
        if (d === '`' && !ps) {
          const e = s.indexOf('`', i + 1);
          if (e < 0) { buf += d; i++; continue; }
          sub(s.slice(i + 1, e));
          buf += '\u0000'; i = e + 1; continue;
        }
        buf += d; i++;
      }
      continue;
    }
    if (c === '\\' && !ps) {
      if (s[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < n) { buf += '\\' + s[i + 1]; started = true; }
      i += 2; continue;
    }
    if (c === '`') {
      if (ps) { if (i + 1 < n) { buf += s[i + 1]; started = true; } i += 2; continue; }
      const e = s.indexOf('`', i + 1);
      if (e < 0) { buf += c; started = true; i++; continue; }
      sub(s.slice(i + 1, e));
      buf += '\u0000'; started = true; i = e + 1; continue;
    }
    if (c === '$' && s[i + 1] === '(' && s[i + 2] === '(') { // arithmetic: data
      const e = matchClose(i + 1, '(', ')');
      buf += '\u0000'; started = true; i = e < 0 ? n : e; continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      const e = matchClose(i + 1, '(', ')');
      if (e < 0) { buf += c; started = true; i++; continue; }
      sub(s.slice(i + 2, e - 1));
      buf += '\u0000'; started = true; i = e; continue;
    }
    if (c === '$' && s[i + 1] === '{') {
      const e = matchClose(i + 1, '{', '}');
      buf += e < 0 ? s.slice(i) : s.slice(i, e); started = true; i = e < 0 ? n : e; continue;
    }
    if (c === '(') {
      if (ps) {
        const e = matchClose(i, '(', ')');
        if (e < 0) { buf += c; started = true; i++; continue; }
        const inner = s.slice(i + 1, e - 1);
        if (started && buf !== '') { buf += '(' + inner + ')'; sub(inner); } // method call: kept as text for .Kill( detection
        else { sub(inner); buf += '\u0000'; started = true; }
        i = e; continue;
      }
      endCmd(); newChain(); i++; continue; // bash subshell
    }
    if (c === ')') { endCmd(); newChain(); i++; continue; }
    if (c === '{' && ps) { endWord(); endCmd(); depthBrace++; i++; continue; }
    if (c === '}' && ps) { endCmd(); depthBrace = Math.max(0, depthBrace - 1); i++; continue; }
    if (c === ';') { endCmd(); newChain(); i++; continue; }
    if (c === '|') {
      endCmd();
      if (s[i + 1] === '|') { newChain(); i += 2; continue; }
      i += (s[i + 1] === '&') ? 2 : 1;
      continue;
    }
    if (c === '&') {
      const prev = s[i - 1];
      const nx = s[i + 1];
      if (prev === '>' || prev === '<' || nx === '>') { buf += c; started = true; i++; continue; }
      if (nx === '&') { endCmd(); newChain(); i += 2; continue; }
      if (ps && !started && words.length === 0) { i++; continue; } // call operator
      endCmd(); newChain(); i++; continue;
    }
    if (c === '<' && !ps && s[i + 1] === '<' && s[i + 2] !== '<') {
      let j = i + 2;
      let dash = false;
      if (s[j] === '-') { dash = true; j++; }
      while (s[j] === ' ' || s[j] === '\t') j++;
      let delim = '';
      if (s[j] === "'" || s[j] === '"') {
        const q = s[j]; const e = s.indexOf(q, j + 1);
        if (e > 0) { delim = s.slice(j + 1, e); j = e + 1; }
      } else {
        const m = /^[^\s;&|<>()]+/.exec(s.slice(j));
        if (m) { delim = m[0].replace(/\\/g, ''); j += m[0].length; }
      }
      endWord();
      if (delim) pendingHere.push({ delim, dash, list: heredocs });
      i = j; continue;
    }
    buf += c; started = true; i++;
  }
  endCmd();
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Command analysis

export function baseName(w) {
  let t = String(w).toLowerCase();
  const k = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (k >= 0) t = t.slice(k + 1);
  return t.replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}

// skip env / timeout / sudo / nohup ... ; returns the index of the program word, or -1
export function progIndex(w) {
  let k = 0;
  let guard = 0;
  while (k < w.length && guard++ < 20) {
    const a = w[k].t;
    const b = baseName(a);
    if (!w[k].q && PS_ASSIGN.test(a)) { k++; continue; }
    if (['exec', 'command', 'builtin', 'nohup', 'time', 'setsid', 'nice', 'stdbuf', 'call', 'then', 'do', 'else', 'elif', 'if', 'while', 'until'].includes(b)) { k++; continue; }
    if (b === 'env') {
      k++;
      while (k < w.length) {
        const x = w[k].t;
        if (PS_ASSIGN.test(x)) { k++; continue; }
        if (x === '--') { k++; break; }
        if (x.length > 1 && x[0] === '-') { k += /^-(u|C|S|-unset|-chdir)$/.test(x) ? 2 : 1; continue; }
        break;
      }
      continue;
    }
    if (b === 'timeout') {
      k++;
      while (k < w.length && w[k].t[0] === '-' && w[k].t.length > 1) k += /^(-s|-k|--signal|--kill-after)$/.test(w[k].t) ? 2 : 1;
      k++; // the duration
      continue;
    }
    if (b === 'sudo') {
      k++;
      while (k < w.length && w[k].t[0] === '-' && w[k].t.length > 1) k += /^(-u|-g|-h|-p|-C|-D|-R|-T|-U)$/.test(w[k].t) ? 2 : 1;
      continue;
    }
    return k;
  }
  return -1;
}

export function psParam(a, names) { // does PowerShell parameter word `a` abbreviate one of `names` (min lengths in the pair)
  const m = /^-([A-Za-z]+)(?::|$)/.exec(a);
  if (!m) return false;
  const p = m[1].toLowerCase();
  return names.some(([full, min]) => p.length >= min && full.startsWith(p));
}
const hasParam = (args, names) => args.some((a) => psParam(a, names));
// value of -Filter / -Query style parameter: the next word, or the text after ':'
function paramValue(args, names) {
  for (let k = 0; k < args.length; k++) {
    if (psParam(args[k], names)) {
      const colon = args[k].indexOf(':');
      if (colon > 0) return args[k].slice(colon + 1);
      return args[k + 1] ?? '';
    }
  }
  return null;
}

const NAME_PARAMS = [['name', 1], ['processname', 3]];
const ID_PARAMS = [['id', 1], ['pid', 3]];

const isStaticSource = (words) => words.some((x) => /getprocessesbyname/i.test(x.t));

function isSourceByName(prog, args, shell) {
  if (prog === 'get-process' || prog === 'gps' || (prog === 'ps' && shell === 'powershell')) {
    return !hasParam(args, ID_PARAMS);
  }
  if (['get-ciminstance', 'gcim', 'get-wmiobject', 'gwmi'].includes(prog)) {
    if (!args.some((a) => /win32_process/i.test(a))) return false;
    const f = paramValue(args, [['filter', 1], ['query', 1]]);
    if (f != null && /^\s*(parent)?processid\s*=\s*\d+\s*$/i.test(f)) return false;
    return true;
  }
  if (prog === 'pgrep' || prog === 'pidof') {
    // -P parent / -g group / -s session / -t terminal select by relationship, not by image name
    const scoped = args.some((a) => /^-[A-Za-z]*[PgsStT]\d*$/.test(a));
    return args.length > 0 && !scoped;
  }
  return false;
}

// a command that kills; `viaPipe` = it is downstream of a name source in one chain
function killsSomething(prog, args, words, shell) {
  if (prog === 'stop-process' || prog === 'spps') return true;
  if (prog === 'kill' && shell === 'powershell') return true;
  if (prog === 'kill' || prog === 'taskkill' || prog === 'pkill' || prog === 'killall') return true;
  if (prog === 'xargs' && args.some((a) => ['kill', 'taskkill', 'stop-process'].includes(baseName(a)))) return true;
  if (prog === 'invoke-cimmethod' && args.some((a) => /terminate/i.test(a))) return true;
  if (prog === 'remove-ciminstance' || prog === 'remove-wmiobject') return true;
  if (words.some((x) => !x.q && /\.(kill|terminate)\(/i.test(x.t))) return true;
  return false;
}

function analyze(cmd, shell, depth, st, hits) {
  const w = cmd.words;
  const k = progIndex(w);
  if (k < 0 || k >= w.length) return;
  const progRaw = w[k].t;
  const prog = baseName(progRaw);
  const args = w.slice(k + 1).map((x) => x.t);
  const argsLower = args.map((a) => a.toLowerCase());

  // --- nested shells: judge their script as commands ---
  const nested = [];
  if (SHELLS.has(prog)) {
    const ci = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (ci >= 0 && args[ci + 1] !== undefined) nested.push([args[ci + 1], 'bash']);
    else if (ci < 0 && args.every((a) => a[0] === '-')) for (const h of (cmd.chainHere || cmd.heredocs)) nested.push([h, 'bash']);
  } else if (PS_SHELLS.has(prog)) {
    const ci = args.findIndex((a) => psParam(a, [['command', 1]]) || a.toLowerCase() === '-c');
    if (ci >= 0 && args[ci + 1] !== undefined) nested.push([args.slice(ci + 1).join(' '), 'powershell']);
    else if (ci < 0 && args.every((a) => a[0] === '-')) for (const h of (cmd.chainHere || cmd.heredocs)) nested.push([h, 'powershell']);
  } else if (prog === 'cmd') {
    const ci = args.findIndex((a) => /^[/-]{1,2}[ck]$/i.test(a));
    if (ci >= 0 && args[ci + 1] !== undefined) nested.push([args.slice(ci + 1).join(' '), 'bash']);
  } else if (prog === 'eval') {
    nested.push([args.join(' '), shell]);
  } else if (prog === 'invoke-expression' || prog === 'iex') {
    nested.push([args.join(' '), 'powershell']);
  }
  for (const [script, sh] of nested) scan(script, sh, depth + 1, st, hits);

  // --- plugin uninstall ---
  const claudeLike = prog === 'claude' || (['npx', 'bunx', 'pnpm', 'npm', 'yarn', 'node'].includes(prog) && args.some((a) => /(^|[\\/@])claude(-code)?([\\/]|$|@)/i.test(a) && !/^-/.test(a)));
  if (claudeLike) {
    const pi = args.findIndex((a) => /^plugins?$/i.test(a));
    if (pi >= 0) {
      const next = args.slice(pi + 1).find((a) => a[0] !== '-');
      if (next && /^(uninstall|remove|rm|delete)$/i.test(next)) hits.uninstall = true;
    }
  }

  // --- kill by name ---
  if (prog === 'pkill' || prog === 'killall') hits.kill = hits.kill || prog;
  else if (prog === 'taskkill') {
    const help = args.length === 1 && /^[/-]{1,2}\?$/.test(args[0]);
    const hasPid = argsLower.some((a) => /^[/-]{1,2}pid$/.test(a));
    const hasIm = argsLower.some((a) => /^[/-]{1,2}im$/.test(a));
    const fi = argsLower.some((a, j) => /^[/-]{1,2}fi$/.test(a) && /imagename|windowtitle/.test(argsLower[j + 1] || ''));
    if (!help && (!hasPid || hasIm || fi)) hits.kill = hits.kill || 'taskkill';
  } else if (prog === 'stop-process' || prog === 'spps' || (prog === 'kill' && shell === 'powershell')) {
    if (hasParam(args, NAME_PARAMS)) hits.kill = hits.kill || 'Stop-Process -Name';
  } else if (prog === 'wmic') {
    const l = argsLower.join(' ');
    if (/\bprocess\b/.test(l) && /\b(delete|terminate)\b/.test(l) && !/where\s*\(?\s*["']?\s*processid\s*=/.test(l)) hits.kill = hits.kill || 'wmic process';
  }
  // a kill command fed by a name lookup inside its own arguments: kill $(pgrep x), Stop-Process -Id (Get-Process x).Id
  if (killsSomething(prog, args, w, shell) && cmd.subs.some((sc) => subIsSource(sc, shell))) hits.kill = hits.kill || 'kill fed by a name lookup';

}

function subIsSource(sc, shell) {
  const k = progIndex(sc.words);
  if (k < 0 || k >= sc.words.length) return false;
  return isSourceByName(baseName(sc.words[k].t), sc.words.slice(k + 1).map((x) => x.t), shell) || isStaticSource(sc.words);
}

// pipeline rule: a name source followed, in the same chain, by a killer
function pipelineHits(cmds, shell, hits) {
  const byChain = new Map();
  for (const c of cmds) {
    if (!byChain.has(c.chain)) byChain.set(c.chain, []);
    byChain.get(c.chain).push(c);
  }
  for (const list of byChain.values()) {
    let seenSource = false;
    for (const c of list) {
      const k = progIndex(c.words);
      if (k < 0 || k >= c.words.length) continue;
      const prog = baseName(c.words[k].t);
      const args = c.words.slice(k + 1).map((x) => x.t);
      if (seenSource && killsSomething(prog, args, c.words, shell)) { hits.kill = hits.kill || 'name lookup piped to a kill'; return; }
      if (isSourceByName(prog, args, shell) || isStaticSource(c.words)) seenSource = true;
    }
  }
}

// parse one script, analyze each command, then the pipeline rule
function scan(text, shell, depth, st, hits) {
  if (depth > MAX_DEPTH) return;
  const cmds = parseCommands(text, shell, depth, st);
  // a shell reading its script from stdin runs the heredoc bodies of the commands piped into it (cat <<E | bash)
  const here = new Map();
  for (const c of cmds) {
    const acc = [...(here.get(c.chain) || []), ...c.heredocs];
    here.set(c.chain, acc);
    c.chainHere = acc;
  }
  for (const c of cmds) analyze(c, shell, depth, st, hits);
  pipelineHits(cmds, shell, hits);
}

function collect(command, shell) {
  const hits = { kill: null, uninstall: false };
  scan(command, shell, 0, { nextChain: 0, steps: 0 }, hits);
  return hits;
}

/**
 * Judge one Bash or PowerShell command. Returns { kill: string|null, uninstall: boolean }; both falsy when the
 * command is fine. shell: 'bash' (default) or 'powershell'. Never throws: any failure allows.
 */
export function processGuardHits(command, shell = 'bash') {
  try {
    const cmd = String(command || '');
    if (!cmd) return { kill: null, uninstall: false };
    // cheap prefilter: nothing to judge unless one of the words appears somewhere
    if (!/kill|stop-process|spps|wmic|terminate|remove-cim|remove-wmi|plugin/i.test(cmd)) return { kill: null, uninstall: false };
    return collect(cmd, shell === 'powershell' ? 'powershell' : 'bash');
  } catch { return { kill: null, uninstall: false }; }
}

/** Hook entry: { message, kind: 'kill-by-name'|'plugin-uninstall', mode } or null. opts.mode is deny|warn|off for the kill rule. */
export function processGuard(payload, opts = {}) {
  const command = payload?.tool_input?.command;
  const shell = payload?.tool_name === 'PowerShell' ? 'powershell' : 'bash';
  const mode = String(opts.mode ?? 'deny').toLowerCase();
  const r = processGuardHits(command, shell);
  if (r.uninstall) return { kind: 'plugin-uninstall', message: UNINSTALL_MSG, mode: 'deny', detail: String(command) };
  if (r.kill && mode !== 'off') return { kind: 'kill-by-name', message: KILL_MSG, mode: mode === 'warn' ? 'warn' : 'deny', detail: `${r.kill}: ${String(command)}` };
  return null;
}
