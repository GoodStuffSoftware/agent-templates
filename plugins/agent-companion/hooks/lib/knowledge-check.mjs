// Knowledge check, shipped (0.31.57). Before a builder starts, one look at the current docs of what it will use,
// so it does not build on remembered facts that moved. Per task type, because the measured gain is in the builder
// types (docs/adr/0007-knowledge-check-by-type.md):
//
//   - SPAWN: a brief whose TYPE is in the list (option knowledge_check_types) gets one short clause, unless it
//     already carries a "Knowledge check YYYY-MM-DD:" line dated today or yesterday (the lead's own check, which the
//     worker reuses). Any other TYPE, a reviewer and a brief with no TYPE get nothing.
//   - LEAD NOTICE: the first spawn of a session that gets the clause also tells the lead, once, to run one check for
//     the whole body of work and pass it down as a dated line. Held until an allow is emitted and claimed with an
//     exclusive marker file, the way lib/lead-effort-live.mjs does it.
//   - HOW-TO: the built-in standing rule knowledge-check-howto (lib/rules.mjs), gated on the same option.
//
// The option knowledge_check (default on) switches all three off. Pure helpers plus one marker file; fail open.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { opt, stateDir } from './context.mjs';
import { declarationLines } from './brief-directives.mjs';

export const KC_MARKER = '[agent-companion: knowledge check]';
// The shipped default: the builder types, where a stale idea of an API or a tool costs a rebuild.
export const KC_DEFAULT_TYPES = [
  'bounded-feature', 'bounded-feature-small', 'integration', 'debug-root-cause',
  'critical-change', 'novel-design', 'large-refactor', 'long-autonomous-run',
];
export const KC_DEFAULT_TYPES_TEXT = KC_DEFAULT_TYPES.join(',');

export function knowledgeCheckOn() {
  try { return opt('knowledge_check', true) !== false; } catch { return true; }
}

// The configured type list, lowercase. An unset or empty option is the shipped list.
export function knowledgeCheckTypes() {
  let raw = KC_DEFAULT_TYPES_TEXT;
  try { raw = String(opt('knowledge_check_types', KC_DEFAULT_TYPES_TEXT)); } catch { /* default */ }
  const list = raw.split(/[,;\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : [...KC_DEFAULT_TYPES];
}

// Local calendar date as YYYY-MM-DD; AGENT_COMPANION_FAKE_NOW moves the clock for tests.
export function localDate(offsetDays = 0, now) {
  const base = now instanceof Date ? now : (process.env.AGENT_COMPANION_FAKE_NOW ? new Date(process.env.AGENT_COMPANION_FAKE_NOW) : new Date());
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

const DATED_LINE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?Knowledge check[ \t]+(\d{4}-\d{2}-\d{2})(?:\*\*|__)?[ \t]*:/i;

// True when the brief carries a "Knowledge check YYYY-MM-DD:" line dated today or yesterday (local date). A line in a
// code fence, a blockquote or an HTML comment is not read (declarationLines), so a quoted earlier brief does not count.
export function hasFreshKnowledgeLine(brief, now) {
  try {
    const ok = new Set([localDate(0, now), localDate(-1, now)]);
    for (const line of declarationLines(String(brief ?? ''))) {
      const m = DATED_LINE.exec(line);
      if (m && ok.has(m[1])) return true;
    }
  } catch { /* fail open: no reuse, the clause is added */ }
  return false;
}

// The clause (about 340 characters), dated with the local date so the worker's report line is exact.
export function knowledgeClause(now) {
  const d = localDate(0, now);
  return `${KC_MARKER} Before your first edit, run ONE WebSearch (or WebFetch of the official docs or changelog) on the main library or tool you use. ` +
    `Open your report "Knowledge check ${d}: confirmed" or "changed: <what>"; if it contradicts the brief, stop and report. ` +
    'No outside dependency: "Knowledge check: none needed (<why>)".';
}

export const KC_LEAD_NOTICE = 'agent-companion: this brief gets a knowledge check clause. Run one check (WebSearch, or WebFetch of the official docs) for this whole body of work and pass it down as "Knowledge check <date>: ..." in each brief, so workers reuse it.';

// 'clause' | 'reused' | null: what this spawn gets. Pure (no marker file).
export function knowledgeDecision({ type, role, brief, now } = {}) {
  if (!knowledgeCheckOn()) return null;
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  if (!t || !knowledgeCheckTypes().includes(t)) return null;
  if (typeof role === 'string' && role.toLowerCase() === 'reviewer') return null;
  const text = String(brief ?? '');
  if (text.includes(KC_MARKER)) return null; // already appended (a re-spawned brief)
  return hasFreshKnowledgeLine(text, now) ? 'reused' : 'clause';
}

// The text to append to the brief, or ''.
export function buildKnowledgeClause({ type, role, brief, now } = {}) {
  return knowledgeDecision({ type, role, brief, now }) === 'clause' ? `\n\n${knowledgeClause(now)}` : '';
}

// ---- the once-per-session lead notice ------------------------------------------------------------------------------
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_MARKERS = 200;

function claim(sid) {
  try {
    const dir = join(stateDir(), 'knowledge-check-notice');
    mkdirSync(dir, { recursive: true });
    prune(dir);
    const name = `${createHash('sha256').update(String(sid)).digest('hex').slice(0, 16)}.said`;
    writeFileSync(join(dir, name), new Date().toISOString(), { flag: 'wx' });
    return true;
  } catch {
    return false; // already said (EEXIST), or the state dir is unwritable: say nothing
  }
}

function prune(dir) {
  try {
    const now = Date.now();
    const files = readdirSync(dir).filter((f) => f.endsWith('.said')).map((f) => {
      try { return { f, t: statSync(join(dir, f)).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.t - a.t);
    files.forEach((x, i) => {
      if (i >= MAX_MARKERS || now - x.t > KEEP_MS) { try { unlinkSync(join(dir, x.f)); } catch { /* ignore */ } }
    });
  } catch { /* fail open */ }
}

let pending = null; // { sid } set by holdKnowledgeNotice(), read once by mergeKnowledgeNotice()

// Called by the spawn guard when it appends the clause. The notice is for the lead only (a worker spawning a
// worker is not told) and never for a canary probe. Held until an allow is emitted.
export function holdKnowledgeNotice({ sid, subagentCaller, isCanary }) {
  pending = null;
  try {
    if (subagentCaller || isCanary || !sid) return;
    pending = { sid };
  } catch { /* fail open */ }
}

// Adds the held notice to the allow's additionalContext when this process wins the once-per-session claim.
export function mergeKnowledgeNotice(additionalContext) {
  const p = pending;
  if (!p) return additionalContext;
  pending = null;
  if (!claim(p.sid)) return additionalContext;
  return [additionalContext, KC_LEAD_NOTICE].filter((x) => typeof x === 'string' && x.trim()).join('\n\n');
}
