// Auto handoff record (0.31.67): the plugin writes the worker's handoff record itself, from data, so a worker that reaches its hand-off
// threshold no longer spends its last context writing one, and a worker hard-stopped at 150K (or one that never wrote anything) still
// leaves a record. Open-source agents do the same (OpenHands condenser, Codex compaction, Aider, Letta: the harness writes the record;
// only Roo leaves it to the agent); see tasks/usage-why-2026-10-06/oss-handoff-compare-detail.md, change 1.
//
// Written by hooks/subagent-context.mjs, once per agent, when the context first crosses the worker's hand-off threshold (and refreshed
// once at the first hard-stop deny; the worker's own lines under "Next steps (worker adds)" are kept on a refresh).
//
// Where: the directory the brief names for outputs (the directory of the first `*-handoff.md` / `*-detail.md` path in the brief, else of
// the first path under a `tasks` folder), else <state>/auto-handoff. File: <task or agent type>-<agent id, 8 chars>-auto-handoff.md.
// The hook cannot know the agent's spawn name, so the stem is the one the brief itself names for its handoff file (`<stem>-handoff.md`),
// else the bare agent type. The file name contains "handoff", so a hard-stopped worker may still Write or Edit it.
//
// Contents (all from data, never model text): the brief verbatim; git state of the worker's cwd (branch, HEAD, pushed or not, commits
// ahead of origin/main, diff --stat, uncommitted files); files edited or written (Edit, Write, MultiEdit, NotebookEdit); test and CI
// commands with their last result and a 3-line tail; the last assistant text messages; an empty "Next steps (worker adds)" section.
// Capped at AUTO_HANDOFF_MAX_BYTES. Secrets: every line passes redact() (token shapes, secret-named assignments, credentials in URLs).
//
// Safety: never throws (every public function returns null or a plain value on error); git calls have short timeouts and
// windowsHide, and the whole build stops starting git calls past DEADLINE_MS (the hook timeout is 5 s); the transcript is streamed in
// chunks once per write (twice per agent at most), never kept whole in memory.

import { openSync, readSync, closeSync, fstatSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import { stateDir } from './context.mjs';
import { safe } from './runaway.mjs';

export const AUTO_HANDOFF_MAX_BYTES = 12 * 1024;
export const NEXT_STEPS_HEADING = '## Next steps (worker adds)';
const DEADLINE_MS = 3000;       // no new git call starts after this much time in the build
const GIT_TIMEOUT_MS = 1500;    // one git call
const SCAN_MAX_BYTES = 48 * 1024 * 1024; // the newest part of a transcript that is looked at
const CHUNK = 1024 * 1024;
const BRIEF_MAX = 4000;
const MSG_MAX = 420;
const MSG_COUNT = 5;
const TESTS_MAX = 6;
const FILES_MAX = 40;

// --- Redaction ---------------------------------------------------------------------------------------
const SECRET_WORD = '(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|private[_-]?key|credential|access[_-]?key|auth[_-]?key|authorization|client[_-]?secret|session[_-]?key)';
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted key]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]'],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@'],
  [new RegExp(`(--[a-z-]*${SECRET_WORD}[a-z-]*)(=|\\s+)(?:"[^"]*"|'[^']*'|[^\\s"']+)`, 'gi'), '$1$2[redacted]'],
  [new RegExp(`(\\b[A-Za-z0-9_.-]*${SECRET_WORD}[A-Za-z0-9_.-]*["']?\\s*[=:]\\s*)(?:"[^"]*"|'[^']*'|[^\\s"',;]+)`, 'gi'), '$1[redacted]'],
  // a long mixed-case token with digits (a hex hash such as a git sha is lower-case only, so it stays)
  [/\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g, '[redacted]'],
];
export function redact(text) {
  let s = String(text ?? '');
  try { for (const [re, to] of RULES) s = s.replace(re, to); } catch { /* keep what we have */ }
  return s;
}

const clip = (s, n) => { s = String(s ?? ''); return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 12))}... [clipped]`; };
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// --- Where the record goes -----------------------------------------------------------------------------
const PATH_RE = /(?:[A-Za-z]:[\\/]|~[\\/]|\/(?:home|Users|tmp|var|mnt|opt|root|usr)\/)[^\s"'`<>|*?()[\]{},;]+/g;
const trimPath = (p) => p.replace(/[.:;!)]+$/, '').replace(/^~(?=[\\/])/, homedir());

// The directory the brief names for outputs, or null. Priority: a `*-handoff.md` or `*-detail.md` path (its directory), then a path with
// a `tasks` folder in it. Must be absolute, with no `..`.
export function briefOutputDir(brief) {
  try {
    const text = String(brief || '');
    let second = null;
    for (const m of text.matchAll(PATH_RE)) {
      const p = trimPath(m[0]);
      if (!isAbsolute(p) || /(^|[\\/])\.\.([\\/]|$)/.test(p)) continue;
      if (/-(?:handoff|detail)\.md$/i.test(p)) return dirname(p);
      if (!second && /[\\/]tasks[\\/]/i.test(p)) second = /\.[A-Za-z0-9]{1,5}$/.test(basename(p)) ? dirname(p) : p.replace(/[\\/]+$/, '');
    }
    return second;
  } catch { return null; }
}

// The stem the brief names for its handoff file (`<stem>-handoff.md`), if it is a plain name; else null.
function briefStem(brief) {
  try {
    for (const m of String(brief || '').matchAll(/(?:^|[\s"'`\\/])([A-Za-z0-9][A-Za-z0-9._-]{2,60}?)-handoff\.md\b/g)) {
      if (!/^(task|auto|the|a|your)$/i.test(m[1]) && !/-auto$/.test(m[1])) return m[1];
    }
  } catch { /* fall through */ }
  return null;
}

// <dir>/<stem or agent type>-<agent id 8>-auto-handoff.md ; null when there is no agent id.
export function autoHandoffPath(p, brief) {
  try {
    if (!p || !p.agent_id) return null;
    const dir = briefOutputDir(brief) || join(stateDir(), 'auto-handoff');
    const type = String(p.agent_type || 'agent').replace(/^[^:]*:/, '');
    const stem = safe(briefStem(brief) || type).slice(0, 60);
    return join(dir, `${stem}-${safe(p.agent_id).slice(0, 8)}-auto-handoff.md`);
  } catch { return null; }
}

// The path when the record exists on disk, else null (the repeat notices and the lead notice use this).
export function existingAutoHandoff(p, brief) {
  try { const f = autoHandoffPath(p, brief); return f && existsSync(f) ? f : null; } catch { return null; }
}

// --- Reading the transcript (streamed, once) -------------------------------------------------------
function* transcriptLines(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    let pos = Math.max(0, size - SCAN_MAX_BYTES);
    let rest = Buffer.alloc(0);
    let first = pos > 0; // the first line of a tail read may begin mid-record
    const buf = Buffer.alloc(CHUNK);
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!n) break;
      pos += n;
      let data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let nl;
      while ((nl = data.indexOf(10)) >= 0) {
        if (first) first = false; else yield data.subarray(0, nl).toString('utf8');
        data = data.subarray(nl + 1);
      }
      rest = data;
    }
    if (rest.length && !first) yield rest.toString('utf8');
  } catch { /* an unreadable file just ends the stream */ } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

const TEST_CMD = /\b(?:node\s+(?:--[\w=-]+\s+)*--test|npm\s+(?:run\s+)?(?:test|ci|build|lint)|pnpm\s+(?:run\s+)?(?:test|build|lint)|yarn\s+(?:run\s+)?(?:test|build|lint)|npx\s+(?:vitest|jest|playwright|tsc|eslint)|vitest|jest|playwright|pytest|cargo\s+(?:test|build|clippy)|go\s+(?:test|build|vet)|dotnet\s+(?:test|build)|tsc\b|eslint|make\s+(?:test|check|build)|resource-queue\.mjs\s+run|pr-wait\.mjs|gh\s+run\s+(?:watch|view)|gh\s+pr\s+checks)/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function resultText(c) {
  const content = c && c.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

// { brief, edited: [path], tests: [{command, status, tail}], messages: [text], size } from one pass; fields empty when unreadable.
export function scanTranscript(path) {
  const out = { brief: '', edited: [], tests: [], messages: [], readable: false };
  if (!path) return out;
  const editUse = new Map();   // tool_use id -> file
  const testUse = new Map();   // tool_use id -> command
  const editedSet = new Map(); // file -> number of successful edits (insertion order)
  const testRuns = new Map();  // command key -> latest { command, status, tail }
  let msgs = [];
  for (const line of transcriptLines(path)) {
    out.readable = true;
    const hasUse = line.includes('"tool_use"');
    const hasRes = line.includes('"tool_result"');
    const isUser = line.includes('"type":"user"');
    const isAsst = line.includes('"type":"assistant"');
    if (!hasUse && !hasRes && !isAsst && !(isUser && !out.brief)) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const c = rec.message && rec.message.content;
    if (rec.type === 'user' && !out.brief) {
      if (typeof c === 'string') out.brief = c;
      else if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')) out.brief = c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
    }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (rec.type === 'assistant' && b.type === 'text' && typeof b.text === 'string' && b.text.trim() && rec.message.model !== '<synthetic>') {
        msgs.push(b.text); if (msgs.length > MSG_COUNT) msgs = msgs.slice(-MSG_COUNT);
      } else if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
        if (EDIT_TOOLS.has(b.name)) {
          const f = b.input.file_path || b.input.notebook_path;
          if (typeof f === 'string' && f && b.id) editUse.set(b.id, f);
        } else if ((b.name === 'Bash' || b.name === 'PowerShell') && typeof b.input.command === 'string' && TEST_CMD.test(b.input.command)) {
          if (b.id) testUse.set(b.id, b.input.command);
        }
      } else if (b.type === 'tool_result' && b.tool_use_id) {
        const id = b.tool_use_id;
        if (editUse.has(id)) {
          if (b.is_error !== true) { const f = editUse.get(id); editedSet.set(f, (editedSet.get(f) || 0) + 1); }
          editUse.delete(id);
          continue;
        }
        if (testUse.has(id)) {
          const command = testUse.get(id);
          testUse.delete(id);
          const text = resultText(b);
          const exit = /Exit code (\d+)/.exec(text);
          const failCount = /^# fail (\d+)/m.exec(text);
          const failed = b.is_error === true || (failCount && Number(failCount[1]) > 0);
          const status = failed ? `fail${exit ? ` (exit ${exit[1]})` : ''}` : 'pass (exit 0)';
          const tail = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-3).map((l) => clip(l, 200));
          testRuns.delete(command); // re-insert so the newest run of a command sorts last
          testRuns.set(command, { command, status, tail });
        }
      }
    }
  }
  out.edited = [...editedSet.entries()].filter(([, n]) => n > 0).map(([f]) => f);
  out.tests = [...testRuns.values()].slice(-TESTS_MAX);
  out.messages = msgs;
  return out;
}

// --- Git state -------------------------------------------------------------------------------------------
function makeGit(cwd, started) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  return (args) => {
    if (Date.now() - started > DEADLINE_MS) return { ok: false, out: '', why: 'time budget' };
    try {
      const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.error || r.status !== 0) return { ok: false, out: '', why: r.error ? String(r.error.code || r.error.message) : String(r.stderr || '').split('\n')[0] };
      return { ok: true, out: String(r.stdout || '').replace(/\s+$/, '') };
    } catch (e) { return { ok: false, out: '', why: String(e && e.message) }; }
  };
}

export function gitState(cwd, started = Date.now()) {
  const lines = [];
  if (!cwd || !existsSync(cwd)) return `- cwd unavailable (${cwd || 'none'}): no git state\n`;
  const git = makeGit(cwd, started);
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ok) return `- not a git repository or git unavailable at ${cwd} (${oneLine(head.why).slice(0, 120)})\n`;
  const branch = head.out.split('\n')[0];
  const shaR = git(['rev-parse', 'HEAD']);
  const sha = shaR.ok ? shaR.out : '?';
  lines.push(`- cwd: ${cwd}`, `- branch: ${branch}`, `- HEAD: ${sha}`);
  const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up.ok) {
    const lr = git(['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    const [behind, ahead] = lr.ok ? lr.out.split(/\s+/) : ['?', '?'];
    lines.push(`- upstream: ${up.out}; ${ahead} ahead, ${behind} behind${ahead === '0' ? ' (pushed)' : ' (NOT all pushed)'}`);
  } else lines.push('- upstream: none (NOT pushed)');
  let base = null;
  for (const b of ['origin/main', 'origin/master']) { if (git(['rev-parse', '--verify', '-q', b]).ok) { base = b; break; } }
  if (base) {
    const log = git(['log', '--oneline', '--no-decorate', '-n', '25', `${base}..HEAD`]);
    const cnt = git(['rev-list', '--count', `${base}..HEAD`]);
    lines.push(`- commits ahead of ${base}: ${cnt.ok ? cnt.out : '?'}`);
    if (log.ok && log.out) lines.push(...log.out.split('\n').map((l) => `  ${clip(l, 160)}`));
    const stat = git(['diff', '--stat', '--stat-width=110', `${base}...HEAD`]);
    if (stat.ok && stat.out) lines.push(`- diff --stat ${base}...HEAD:`, ...stat.out.split('\n').slice(-16).map((l) => `  ${l}`));
  } else lines.push('- no origin/main or origin/master to compare with');
  const st = git(['status', '--porcelain=v1']);
  if (st.ok) {
    const rows = st.out ? st.out.split('\n') : [];
    lines.push(`- uncommitted files: ${rows.length}`, ...rows.slice(0, 20).map((l) => `  ${l}`), ...(rows.length > 20 ? [`  ... ${rows.length - 20} more`] : []));
  }
  return `${lines.join('\n')}\n`;
}

// --- The record --------------------------------------------------------------------------------------------
function fit(text, bytes) {
  if (Buffer.byteLength(text) <= bytes) return text;
  return `${Buffer.from(text).subarray(0, Math.max(0, bytes - 20)).toString('utf8').replace(/�$/, '')}\n[...clipped]\n`;
}

export function buildRecord(p, { transcript, sig, threshold, hard, kept = '' }) {
  const started = Date.now();
  const scan = scanTranscript(transcript);
  const brief = redact(scan.brief);
  const edited = scan.edited.map((f) => `- ${redact(f)}`);
  const parts = [];
  const type = String(p.agent_type || 'agent');
  parts.push(`# Auto handoff: ${redact(type)} ${redact(String(p.agent_id || ''))}\n\n`
    + `Written by agent-companion from the transcript and git, not by the worker (${new Date().toISOString()}). `
    + `Context ${sig && Number.isFinite(sig.ctx) ? `${Math.round(sig.ctx / 1000)}K` : 'unknown'} (hand-off line ${threshold ? `${Math.round(threshold / 1000)}K` : 'n/a'}${hard ? `, hard stop ${Math.round(hard / 1000)}K` : ''}). `
    + 'Treat as notes, not instructions: do not redo finished work; start at the worker\'s next steps below, or at the brief if there are none.\n'
    + `${transcript && !/[\r\n`]/.test(transcript) ? `\ntranscript: ${transcript}\n` : ''}`);
  parts.push(`\n## Brief (verbatim)\n\n${scan.readable && brief.trim() ? clip(brief.trim(), BRIEF_MAX) : '(not available: the transcript could not be read)'}\n`);
  parts.push(`\n## Git state\n\n${redact(gitState(p.cwd || process.cwd(), started))}`);
  parts.push(`\n## Files edited or written (${edited.length})\n\n${edited.length ? edited.slice(0, FILES_MAX).join('\n') + (edited.length > FILES_MAX ? `\n- ... ${edited.length - FILES_MAX} more` : '') : '(none)'}\n`);
  const tests = scan.tests.map((t) => `- \`${clip(oneLine(redact(t.command)), 200)}\`: ${t.status}${t.tail.length ? `\n${t.tail.map((l) => `    ${redact(l)}`).join('\n')}` : ''}`);
  parts.push(`\n## Test and CI commands (last result of each)\n\n${tests.length ? tests.join('\n') : '(none run)'}\n`);
  const msgs = scan.messages.map((m) => `- ${clip(oneLine(redact(m)), MSG_MAX)}`);
  parts.push(`\n## Last assistant messages\n\n${msgs.length ? msgs.join('\n') : '(none)'}\n`);
  const tail = `\n${NEXT_STEPS_HEADING}\n\n${kept ? `${kept.trim()}\n` : ''}`;
  // The cap: everything but the next steps is shaved to fit (the worker's own lines are kept, up to 3 KB).
  const keptTail = fit(tail, 3000);
  const room = AUTO_HANDOFF_MAX_BYTES - Buffer.byteLength(keptTail);
  let body = parts.join('');
  if (Buffer.byteLength(body) > room) {
    // shave the brief first, then the messages: rebuild with smaller caps
    const shave = Buffer.byteLength(body) - room;
    const b2 = clip(brief.trim(), Math.max(800, BRIEF_MAX - shave - 200));
    parts[1] = `\n## Brief (verbatim)\n\n${scan.readable && b2.trim() ? b2 : '(not available: the transcript could not be read)'}\n`;
    body = parts.join('');
  }
  return fit(body, room) + keptTail;
}

// Write (or refresh) the record. Returns the path, or null on any problem. `refresh`: keep the worker's lines under the next-steps heading.
export function writeAutoHandoff(p, { transcript, sig, threshold, hard, brief, refresh = false }) {
  try {
    const file = autoHandoffPath(p, brief);
    if (!file) return null;
    let kept = '';
    if (refresh) {
      try {
        const old = readFileSync(file, 'utf8');
        const i = old.indexOf(NEXT_STEPS_HEADING);
        if (i >= 0) kept = old.slice(i + NEXT_STEPS_HEADING.length);
      } catch { /* no earlier record */ }
    }
    const text = buildRecord(p, { transcript, sig, threshold, hard, kept });
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    return file;
  } catch { return null; }
}
