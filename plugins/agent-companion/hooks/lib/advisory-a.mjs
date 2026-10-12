// Three advisory PreToolUse notes: UI sign-off check, windowsHide check, chip
// check. Pure matchers plus a tiny once-per-key state file. Never blocks.
import { join } from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { stateDir, writeTextAtomic } from './context.mjs';

export const PUBLISH_NOTE = 'Publish check: before this goes to the operator, (1) capture it at a narrow width (about 360 px) and look for overflow; (2) exercise every input and button once; (3) for a sign-off, attach the screenshot or the dev URL, not a description.';
export const WINDOW_NOTE = 'This code starts a child process without windowsHide: true. On this machine every spawn, exec and fork must set it (it is mandatory with detached: true), or a console window opens on the operator\'s desktop.';
export const CHIP_NOTE = 'Chip check: if you hold this context and are free, do the follow-up yourself. A chip is for work that needs a different folder, effort or model, or that runs longer than this session should stay open.';

export const ARTIFACT_WINDOW_MS = 30 * 60 * 1000;

// ---- once-per-key state: state/<dir>/<sid>.json = { key: epochMs } ----
function safeSid(sid) { return String(sid || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80); }
export function stateFilePath(dir, sid) { return join(stateDir(), dir, `${safeSid(sid)}.json`); }
function readMap(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}
// True when `key` was not seen within windowMs (Infinity = ever); records it.
export function claim(dir, sid, key, { now = Date.now(), windowMs = Infinity } = {}) {
  const file = stateFilePath(dir, sid);
  const map = readMap(file);
  const prev = map[key];
  if (typeof prev === 'number' && now - prev < windowMs) return false;
  map[key] = now;
  try { mkdirSync(join(stateDir(), dir), { recursive: true }); } catch { /* fail open */ }
  writeTextAtomic(file, JSON.stringify(map));
  return true;
}

// ---- F8 ----
const SIGNOFF_RE = /\b(approve|approval|sign.?off|look good|ok to (merge|ship|land))\b/i;
const UI_RE = /\b(ui|ux|design|screen|modal|page|layout|popup|mockup|desk)\b/i;

function questionText(input) {
  if (!input || typeof input !== 'object') return '';
  const parts = [];
  if (typeof input.question === 'string') parts.push(input.question);
  if (Array.isArray(input.questions)) {
    for (const q of input.questions) {
      if (q && typeof q === 'object') {
        if (typeof q.question === 'string') parts.push(q.question);
        if (typeof q.header === 'string') parts.push(q.header);
      }
    }
  }
  return parts.join('\n');
}
export function signoffQuestion(input) {
  const t = questionText(input);
  return SIGNOFF_RE.test(t) && UI_RE.test(t);
}
export function artifactKey(input) {
  if (input && typeof input === 'object') {
    for (const k of ['id', 'artifact_id', 'artifactId', 'name', 'title']) {
      if (typeof input[k] === 'string' && input[k]) return `${k}:${input[k]}`.slice(0, 200);
    }
  }
  return 'artifact';
}

// ---- F11 ----
export const WINDOW_EXT_RE = /\.(js|mjs|cjs|ts)$/i;
const CALL_RE = /(?:(?<![\w$.])|\b(?:child_process|childProcess|cp)\.)(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g;

// Index just past the ")" matching the "(" at `open`, skipping strings; -1 if unclosed.
function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === '\'' || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}
// Last top-level argument text of an argument string (without the outer parens).
function lastArg(args) {
  let depth = 0; let last = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '"' || c === '\'' || c === '`') {
      for (i++; i < args.length && args[i] !== c; i++) if (args[i] === '\\') i++;
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) last = i + 1;
  }
  return args.slice(last).trim();
}

// True when `text` holds a child_process call whose call text has no
// windowsHide. `context` is text that decides whether child_process is in play
// (the whole file for an Edit). A call whose options are a spread or a variable
// named like options, or that is unclosed in `text`, is skipped (cannot tell).
export function addsUnhiddenSpawn(text, context = text) {
  if (typeof text !== 'string' || !text) return false;
  if (!/child_process/.test(`${context}\n${text}`)) return false;
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(text))) {
    const ls = text.lastIndexOf('\n', m.index - 1) + 1;
    const before = text.slice(ls, m.index);
    if (/^\s*(\/\/|\*|\/\*)/.test(before)) continue;
    // a definition or method call on another object, not the child_process function
    if (/\b(function\*?|async|get|set|new)\s+$/.test(before)) continue;
    const open = m.index + m[0].length - 1;
    const end = matchParen(text, open);
    if (end < 0) continue;
    const args = text.slice(open + 1, end - 1);
    if (/windowsHide/.test(args)) continue;
    const la = lastArg(args);
    if (/^\.\.\./.test(la) || /^[A-Za-z_$][\w$.]*$/.test(la) && /opt|env|config|settings/i.test(la)) continue;
    return true;
  }
  return false;
}

// ---- F13 ----
export const isSpawnTask = (name) => typeof name === 'string' && /^mcp__.*spawn_task$/.test(name);
