// Scheduled-run model/effort drift (the scout's `routine_model_drift` signal).
//
// The desktop app starts a scheduled run on the task's SKILL.md `model:` line, and
// when there is none, on the composer's last-selected model. A folder effort pin is
// keyed to one model id, so a run on another model silently loses it. On 2026-10-13
// the scout ran on Fable at high instead of Opus at low; nothing alerted.
//
// This module READS the app's session records (local_*.json with a scheduledTaskId),
// the tasks' SKILL.md files and each run folder's .claude/settings.local.json. It
// writes nothing, starts no session and fails open: any missing directory or
// unreadable file yields nothing.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const DAY = 24 * 60 * 60 * 1000;
const MAX_FILES = 4000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TASKS = 400;

const readText = (f, max = MAX_BYTES) => {
  try { if (statSync(f).size > max) return null; return readFileSync(f, 'utf8').replace(/^﻿/, ''); } catch { return null; }
};
const readJson = (f) => { const t = readText(f); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };

// Where the app keeps its Code-session records. AGENT_COMPANION_SESSIONS_DIR replaces it (tests).
export function sessionRecordRoot({ env = process.env, platform = process.platform, home } = {}) {
  if (env.AGENT_COMPANION_SESSIONS_DIR) return env.AGENT_COMPANION_SESSIONS_DIR;
  const h = home || homedir();
  const redirected = resolve(h) !== resolve(homedir());
  if (platform === 'win32') return join((!redirected && env.APPDATA) || join(h, 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
  if (platform === 'darwin') return join(h, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  return join((!redirected && env.XDG_CONFIG_HOME) || join(h, '.config'), 'Claude', 'claude-code-sessions');
}

// <root>/<account>/<org>/local_*.json, bounded.
function listRecordFiles(root) {
  const out = [];
  try {
    for (const a of readdirSync(root)) {
      let bs = [];
      try { bs = readdirSync(join(root, a)); } catch { continue; }
      for (const b of bs) {
        let fs = [];
        try { fs = readdirSync(join(root, a, b)); } catch { continue; }
        for (const f of fs) {
          if (/^local_.*\.json$/.test(f)) out.push(join(root, a, b, f));
          if (out.length >= MAX_FILES) return out;
        }
      }
    }
  } catch { /* missing store */ }
  return out;
}

// Scheduled runs created within `windowMs` before `nowMs`, oldest first.
export function scheduledRuns(root, nowMs, windowMs) {
  const runs = [];
  for (const f of listRecordFiles(root)) {
    try {
      if (nowMs - statSync(f).mtimeMs > windowMs + DAY) continue; // untouched for longer than the window
    } catch { continue; }
    const j = readJson(f);
    if (!j || typeof j !== 'object' || typeof j.scheduledTaskId !== 'string' || !j.scheduledTaskId) continue;
    const created = Number(j.createdAt);
    if (!Number.isFinite(created) || nowMs - created > windowMs || created > nowMs + DAY) continue;
    runs.push({
      task: j.scheduledTaskId,
      session: String(j.sessionId || '').replace(/^local_/, '').slice(0, 8),
      cwd: typeof j.cwd === 'string' ? j.cwd : '',
      model: typeof j.model === 'string' ? j.model : '',
      effort: typeof j.effort === 'string' ? j.effort : '',
      createdAt: created,
    });
  }
  return runs.sort((a, b) => a.createdAt - b.createdAt);
}

// The `model:` value in a SKILL.md frontmatter block; null when absent, `default` or `inherit`
// (the app treats those as unset).
export function frontmatterModel(text) {
  if (typeof text !== 'string') return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const line = /^model:[ \t]*(.+?)[ \t]*$/m.exec(m[1]);
  if (!line) return null;
  const v = line[1].replace(/^["'`]|["'`]$/g, '').trim();
  return !v || /^(default|inherit)$/i.test(v) ? null : v;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\[[^\]]*\]$/, '').trim();

// Does the recorded model id satisfy the expected value (an alias such as `opus`, or a full id)?
export function modelMatches(expected, recorded) {
  const e = norm(expected); const r = norm(recorded);
  if (!e || !r) return false;
  if (r === e) return true;
  if (/^claude-/.test(e)) return r.startsWith(e) || e.startsWith(r);
  return new RegExp(`(^|[-.:/])${e.replace(/[^a-z0-9]/g, '')}([-.:/]|$)`).test(r);
}

// The folder's effort pin for one recorded model: { level, keys } (level null when no key matches),
// or null when the folder has no effort pin.
export function folderEffortFor(cwd, recordedModel) {
  const j = cwd ? readJson(join(cwd, '.claude', 'settings.local.json')) : null;
  const ms = j && j.modelSettings;
  if (!ms || typeof ms !== 'object' || Array.isArray(ms)) return null;
  const entries = Object.entries(ms).filter(([, v]) => v && typeof v === 'object' && typeof v.effortLevel === 'string' && v.effortLevel);
  if (!entries.length) return null;
  const hit = entries.find(([k]) => modelMatches(k, recordedModel));
  return { level: hit ? hit[1].effortLevel : null, keys: entries.map(([k]) => k) };
}

// task name -> frontmatter model (null when none).
export function readTaskModels(claudeDirPath) {
  const root = join(claudeDirPath, 'scheduled-tasks');
  const out = new Map();
  let names = [];
  try { names = readdirSync(root).slice(0, MAX_TASKS); } catch { return out; }
  for (const n of names) {
    const t = readText(join(root, n, 'SKILL.md'), 512 * 1024);
    if (t === null) continue;
    out.set(n, frontmatterModel(t));
  }
  return out;
}

// -> { drift: [text], unpinned: [task name] }
// drift: runs created in the last `windowMs` whose recorded model or effort differs from what the
// task's SKILL.md and the run folder's pin say. unpinned: tasks with a SKILL.md and no model: line that
// ran in the last `activeMs` (the app's task store, which holds the enabled flag, is not readable
// by a script, so a run is the evidence that a task is enabled).
export function routineModelDrift({ sessionsRoot, claudeDirPath, nowMs, windowMs = 2 * DAY, activeMs = 14 * DAY }) {
  const drift = [];
  const tasks = readTaskModels(claudeDirPath);
  const recent = scheduledRuns(sessionsRoot, nowMs, activeMs);
  for (const r of recent.filter((x) => nowMs - x.createdAt <= windowMs)) {
    const expectModel = tasks.has(r.task) ? tasks.get(r.task) : null;
    const bits = [];
    if (expectModel && !modelMatches(expectModel, r.model)) bits.push(`model ${r.model || 'unrecorded'} but the task's model: line says ${expectModel}`);
    const pin = folderEffortFor(r.cwd, r.model);
    if (pin) {
      if (pin.level && r.effort && pin.level !== r.effort) bits.push(`effort ${r.effort} but the folder pin for this model says ${pin.level}`);
      if (!pin.level) bits.push(`the folder effort pin is keyed to ${pin.keys.join(', ')}, not ${r.model || 'this model'}, so it did not apply (effort ${r.effort || 'unrecorded'})`);
    }
    if (bits.length) drift.push(`${r.task} run ${r.session} (${new Date(r.createdAt).toISOString().slice(0, 16)}Z, ${r.model || '?'} / ${r.effort || '?'}): ${bits.join('; ')}`);
  }
  const unpinned = [...new Set(recent.map((x) => x.task))].filter((t) => tasks.has(t) && tasks.get(t) === null).sort();
  return { drift, unpinned };
}
