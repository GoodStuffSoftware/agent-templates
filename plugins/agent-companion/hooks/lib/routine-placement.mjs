// Routine placement note: pure builders plus small file readers. Every reader
// returns null on any problem.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NOTE_MAX = 700;
export const REGISTER_ID = 'routine-effort-pins';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

// modelSettings -> "high", or "model=level, ..." when models differ; null when none.
export function effortFromSettings(obj) {
  const ms = obj && typeof obj === 'object' ? obj.modelSettings : null;
  if (!ms || typeof ms !== 'object' || Array.isArray(ms)) return null;
  const pairs = [];
  for (const [model, v] of Object.entries(ms)) {
    const lvl = v && typeof v === 'object' ? v.effortLevel : null;
    if (typeof lvl === 'string' && lvl) pairs.push([model, lvl]);
  }
  if (!pairs.length) return null;
  const levels = [...new Set(pairs.map((p) => p[1]))];
  return levels.length === 1 ? levels[0] : pairs.map((p) => `${p[0]}=${p[1]}`).join(', ');
}

export const folderPin = (cwd) => (cwd ? effortFromSettings(readJson(join(cwd, '.claude', 'settings.local.json'))) : null);
export const userDefault = (claudeDirPath) => effortFromSettings(readJson(join(claudeDirPath, 'settings.json')));

export function readFolderMap(configDirPath) {
  const j = readJson(join(configDirPath, 'routine-pins.json'));
  const f = j && j.folders;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const out = Object.entries(f).filter(([, v]) => typeof v === 'string' && v);
  return out.length ? out : null;
}

export function registerHasId(registerFile, id = REGISTER_ID) {
  const j = readJson(registerFile);
  return !!(j && Array.isArray(j.decisions) && j.decisions.some((d) => d && d.id === id));
}

// True when the call should get a note: any create, or an update that sets `prompt`.
export function applies(toolName, input) {
  if (toolName === 'mcp__scheduled-tasks__create_scheduled_task') return true;
  if (toolName === 'mcp__scheduled-tasks__update_scheduled_task') {
    return !!input && typeof input === 'object' && input.prompt !== undefined && input.prompt !== null;
  }
  return false;
}

const clip = (s, n) => (s.length > n ? `...${s.slice(s.length - n + 3)}` : s);

export function buildNote({ cwd, pin, userDef, map, why }) {
  const start = pin || userDef || 'the app default';
  const head = `Routine placement: this session is in ${clip(String(cwd || 'an unknown folder'), 60)}; folder effort pin: ${pin || 'none'}; a task created here starts at ${start}. `
    + 'Rule: run /ac recommend for the routine\'s parent and its worker (a parent that only spawns one worker and relays the result is weight 1, low) and name the worker\'s rung in the prompt. '
    + 'If the parent\'s level differs from this folder\'s pin, create the task from a session opened in the folder pinned to that level';
  const tail = ' and do not edit the app\'s task store while the app runs.';
  const whyLine = why ? ` Why: decision \`${REGISTER_ID}\` in the decision register.` : '';
  const build = (mapText) => `${head}${mapText}${tail}${whyLine}`;
  if (!map) return build('');
  const full = build(` (map: ${map.map(([k, v]) => `${k}=${clip(v, 45)}`).join('; ')})`);
  if (full.length <= NOTE_MAX) return full;
  const short = build(' (map: see routine-pins.json in the config folder)');
  return short.length <= NOTE_MAX ? short : short.slice(0, NOTE_MAX);
}
