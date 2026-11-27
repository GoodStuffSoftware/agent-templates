// Interrupted background workers, told to the lead once (0.31.62).
//
// An interrupt of the lead (Stop pressed during a tool call) ends every in-flight background subagent of that session at the same
// millisecond: each transcript's last record is the user turn "[Request interrupted by user]", and the lead gets no notification
// (measured 2026-11-21: two writers killed that way, nothing reported). On the lead's next UserPromptSubmit,
// hooks/runaway-notice.mjs calls interruptedNotices(): it lists <lead transcript dir>/<session>/subagents/agent-*.jsonl whose LAST
// record is that marker, skips the ones already reported (one marker file per agent id, advisory-b claimOnce) and returns one line per
// worker: name, description, the time of the interrupt, the last handoff file the worker wrote (if it still exists) and the advice.
//
// Layout and fields (checked against real ~/.claude/projects, 2026-11-21): <project>/<session>.jsonl is the lead; its subagents write
// <project>/<session>/subagents/agent-<id>.jsonl plus agent-<id>.meta.json {agentType, description, name, requestShape: "background"|...}.
// Only the last record counts: a worker resumed after the interrupt has later records and is not interrupted any more. Reads are
// bounded (8 KB tail for the last line, 4 MB tail for the handoff search); every failure is "nothing to report".

import { mkdirSync, readdirSync, readFileSync, statSync, openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { claimOnce } from './advisory-b.mjs';
import { stateDir, readJson, writeJsonAtomic } from './context.mjs';
import { isHandoffPath } from './handoff-limit.mjs';

export const INTERRUPT_MARKER = '[Request interrupted by user]';
const MAX_LINES = 8;
const TAIL_BYTES = 8 * 1024;
const HANDOFF_TAIL_BYTES = 4 * 1024 * 1024;
const LEAD_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // older interrupts are not news

function tail(file, bytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}

// { at } when the transcript's last non-empty line is the interrupt marker (a user record), else null.
export function interruptedAt(file) {
  const lines = tail(file, TAIL_BYTES).split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (!last.includes(`"${INTERRUPT_MARKER}"`)) return null;
  try {
    const o = JSON.parse(last);
    const content = o && o.message && o.message.content;
    const text = Array.isArray(content) ? content.map((c) => (c && c.text) || '').join('') : String(content || '');
    if (o.type !== 'user' || text.trim() !== INTERRUPT_MARKER) return null;
    return { at: typeof o.timestamp === 'string' ? o.timestamp : null };
  } catch { return null; }
}

// The last handoff .md this worker wrote or edited that still exists, else null.
export function lastHandoffFile(file) {
  let found = null;
  for (const l of tail(file, HANDOFF_TAIL_BYTES).split('\n')) {
    if (!l.includes('"tool_use"') || !/handoff/i.test(l)) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use' && ['Write', 'Edit', 'MultiEdit'].includes(c.name) && c.input && isHandoffPath(c.input.file_path)) {
        try { if (existsSync(c.input.file_path)) found = c.input.file_path; } catch { /* ignore */ }
      }
    }
  }
  return found;
}

// Ids the lead stopped on purpose: TaskStop tool_use records in the tail of the lead's own transcript. TaskStop leaves the worker's
// transcript ending in the same interrupt marker, so without this a worker the lead just killed is reported as a surprise.
export function stoppedTaskIds(leadTranscript) {
  const ids = new Set();
  for (const l of tail(leadTranscript, LEAD_TAIL_BYTES).split('\n')) {
    if (!l.includes('"TaskStop"')) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use' && c.name === 'TaskStop' && c.input && typeof c.input.task_id === 'string') ids.add(c.input.task_id);
    }
  }
  return ids;
}

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, n);

function metaOf(file) {
  try { return JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) || {}; } catch { return {}; }
}

function clock(at, fallbackMs) {
  const d = new Date(at || fallbackMs);
  return Number.isNaN(d.getTime()) ? 'an unknown time' : `${d.toISOString().slice(11, 19)}Z`;
}

export function noticeLine(agentId, meta, interrupt, handoff, mtimeMs) {
  const label = [clean(meta.name, 60), meta.description ? `"${clean(meta.description, 90)}"` : ''].filter(Boolean).join(' ') || 'unnamed worker';
  const type = meta.agentType ? `, ${clean(meta.agentType, 60)}` : '';
  return `[agent-companion] background worker interrupted: ${label} (${clean(agentId, 12)}${type}) was cut off by an interrupt at ${clock(interrupt.at, mtimeMs)} `
    + `and the lead got no notification; ${handoff ? `its last handoff file: ${handoff}` : 'it wrote no handoff file'}. `
    + 'Respawn it fresh on the same rung from its handoff or original brief.';
}

// Scan cache (0.31.79): <state>/interrupted-scan/<session>.json maps a transcript file name to { s: size, m: mtimeMs, i: 0|1, at } so a
// prompt after an idle spell re-reads only the files whose size or mtime changed (a big lead holds over a thousand subagent files).
// The notices are the same as without it: a changed file is read again, an unchanged one has the same last line.
const cacheFile = (sid) => join(stateDir(), 'interrupted-scan', `${String(sid).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

// The lines for this lead payload (UserPromptSubmit): [] when there is nothing new. Each worker is reported once.
// opts.deadline (ms epoch): once it has passed, no more files are read; the lines found so far come back and the cache keeps the progress.
export function interruptedNotices(p, { deadline = Infinity } = {}) {
  try {
    const sid = String((p && p.session_id) || '');
    const tp = String((p && p.transcript_path) || '');
    if (!sid || !tp) return [];
    const dir = join(dirname(tp), basename(tp, '.jsonl'), 'subagents');
    const out = [];
    const now = Date.now();
    let stopped = null; // the lead's TaskStop ids, read only when some worker is interrupted
    const cf = cacheFile(sid);
    const prior = readJson(cf, null);
    const cache = prior && typeof prior === 'object' && prior.files && typeof prior.files === 'object' ? prior.files : {};
    const next = {};
    let changed = false;
    let cut = false;
    for (const name of readdirSync(dir)) {
      const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name);
      if (!m) continue;
      if (Date.now() > deadline) { cut = true; break; } // the stat of a thousand files is bounded too; the rest is read on a later prompt
      const file = join(dir, name);
      let st;
      try { st = statSync(file); } catch { continue; }
      let c = cache[name];
      if (!(c && c.s === st.size && c.m === st.mtimeMs)) {
        const it0 = interruptedAt(file);
        c = { s: st.size, m: st.mtimeMs, i: it0 ? 1 : 0, ...(it0 ? { at: it0.at } : {}) };
        changed = true;
      }
      next[name] = c;
      if (!c.i) continue;
      const it = { at: c.at || null };
      const meta = metaOf(file);
      if (typeof meta.requestShape === 'string' && meta.requestShape !== 'background') continue;
      if (!stopped) stopped = stoppedTaskIds(tp);
      if (stopped.has(m[1])) continue; // the lead stopped it on purpose (TaskStop): not a surprise
      const mtimeMs = st.mtimeMs;
      const ts = it.at ? Date.parse(it.at) : NaN;
      const when = Number.isFinite(ts) ? ts : mtimeMs;
      if (when && now - when > MAX_AGE_MS) continue; // an old interrupt the lead has long since handled
      if (!claimOnce('interrupted-told', sid, `${m[1]}@${it.at || 'x'}`)) continue; // a resumed worker interrupted again is reported again
      out.push(noticeLine(m[1], meta, it, lastHandoffFile(file), mtimeMs));
    }
    if (cut) Object.assign(next, Object.fromEntries(Object.entries(cache).filter(([k]) => !(k in next))));
    if (changed || Object.keys(next).length !== Object.keys(cache).length) { try { mkdirSync(dirname(cf), { recursive: true }); writeJsonAtomic(cf, { files: next }); } catch { /* best effort */ } }
    if (out.length > MAX_LINES) return [...out.slice(0, MAX_LINES), `(+${out.length - MAX_LINES} more interrupted workers: ${dir})`];
    return out;
  } catch { return []; }
}
