// Pinned-model-id check (the scout's `pinned_model_id` signal).
//
// A full model id (claude-sonnet-5-5) pinned where the alias (sonnet) would do
// never follows the next release: the alias moves when Anthropic ships, the id
// does not, and nothing errors. A cloud routine created with a pinned id kept
// running on Sonnet 5 after Sonnet 5.5 shipped for exactly that reason.
//
// This module only READS and CLASSIFIES; it writes nothing and makes no network
// call. Surfaces it scans (a claude.ai cloud routine is not among them: a
// script cannot list those, so the scout routine text does that step):
//   1. the plugin's own tier data    (tiers.*.resolvesTo.modelId vs the superseded list)
//   2. scheduled tasks               (<claude dir>/scheduled-tasks/<name>/SKILL.md)
//   3. settings files                (model, env.ANTHROPIC_MODEL, env.CLAUDE_CODE_SUBAGENT_MODEL)
//   4. agent definitions             (frontmatter `model:` in <claude dir>/agents and a project's .claude/agents)
//
// Not flagged on purpose: an alias ("sonnet", "opus[1m]", "inherit"), a key of
// settings.modelSettings (those are keyed by id by design), the env
// ANTHROPIC_DEFAULT_*_MODEL remaps (a gateway or Bedrock/Vertex user must set
// ids there), and an id mentioned in prose (only a line where the word "model"
// directly introduces the id counts).

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { modelTiers, classifyModel, classifyReferenceModel } from '../../hooks/lib/context.mjs';

const FAMILIES = 'opus|sonnet|haiku|fable|mythos';
// claude-sonnet-5-5, claude-opus-4-1-20250805, claude-3-5-sonnet-20241022,
// anthropic.claude-sonnet-5-5-v1:0 (boundary: not preceded by an id character).
const ID = `claude-(?:\\d+(?:-\\d+)?-)?(?:${FAMILIES})-\\d[a-z0-9.:\\-]*`;
const ID_RE = new RegExp(`(?:^|[^a-z0-9-])(${ID})`, 'i');
const ALIAS_RE = new RegExp(`^(?:${FAMILIES}|best|default|inherit|opusplan|sonnetplan)(?:\\[[a-z0-9]+\\])?$`, 'i');
// A line where the word "model" introduces the id: `model: id`, `model="id"`,
// `"model": "id"`, `model set to id`.
const MODEL_LINE_RE = new RegExp(`\\bmodel\\b(?:\\s+(?:set to|is|as|to)|["'\`]?\\s*[:=])?\\s*[\`"'(\\[]*\\s*(${ID})`, 'i');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_TASKS = 400;
const MAX_AGENT_FILES = 400;

const cleanId = (s) => String(s || '').replace(/[.:\-]+$/, '');

// The pinned full id inside a settings/frontmatter VALUE, or null (an alias,
// empty, or no id in it).
export function pinnedIdIn(value) {
  const v = String(value ?? '').trim().replace(/^["'`]|["'`]$/g, '');
  if (!v || ALIAS_RE.test(v)) return null;
  const m = ID_RE.exec(v);
  return m ? cleanId(m[1]) : null;
}

// What the plugin's tier data says about one full id.
//   superseded  the id matches a referenceModels entry (older generation, kept for validation only)
//   current     the id is a tier's own resolvesTo.modelId (right today, wrong after the next release)
//   unlisted    a model id the tier data does not list at all (older than the table, or newer than it)
export function classifyPinned(id, cfg = modelTiers()) {
  const ref = classifyReferenceModel(id);
  const cls = classifyModel(id);
  const alias = cls.known ? cls.alias : (String(id).match(new RegExp(`(${FAMILIES})`, 'i')) || [])[1]?.toLowerCase() || '';
  if (ref && ref.routable === false) {
    return { status: 'superseded', alias, label: ref.displayName || ref.key, note: ref.note ? String(ref.note).split(/(?<=\.)\s/)[0] : '' };
  }
  const current = alias && cfg.tiers?.[alias]?.resolvesTo?.modelId;
  if (current && String(id).toLowerCase().startsWith(String(current).toLowerCase())) {
    return { status: 'current', alias, label: cfg.tiers[alias].resolvesTo.displayName || current, note: '' };
  }
  return { status: 'unlisted', alias, label: '', note: '' };
}

function finding(where, id, extra = {}, cfg) {
  const c = classifyPinned(id, cfg);
  const use = c.alias ? `"${c.alias}"` : 'the alias';
  const why = c.status === 'superseded'
    ? `superseded${c.label ? ` (${c.label})` : ''}`
    : c.status === 'current'
      ? `the current id for ${use}, but a pin never follows the next release`
      : 'an id the tier data does not list';
  return { where, id, status: c.status, alias: c.alias, text: `${where} pins ${id}: ${why}; use ${use}`, ...extra };
}

// 1. The plugin's own tier data. A tier's resolvesTo.modelId is data the setup
// skill, pricing and the plan units read; it must not name a superseded model.
// (planUsageMultipliers.*.priceVectorModel is a documented deliberate pin and
// is not read here.)
export function scanTierData(cfg = modelTiers()) {
  const out = [];
  for (const [alias, spec] of Object.entries(cfg.tiers || {})) {
    const id = spec?.resolvesTo?.modelId;
    if (typeof id !== 'string' || !id) continue;
    const c = classifyPinned(id, cfg);
    if (c.status === 'superseded') out.push(finding(`tier data ${alias}`, id, { surface: 'tier-data' }, cfg));
  }
  return out;
}

function readText(file) {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch { return null; }
}

// 2. Scheduled tasks: <claudeDir>/scheduled-tasks/<task>/SKILL.md.
export function scanScheduledTasks(claudeDirPath, cfg = modelTiers()) {
  const out = [];
  const root = join(claudeDirPath, 'scheduled-tasks');
  let names = [];
  try { names = readdirSync(root).slice(0, MAX_TASKS); } catch { return out; }
  for (const name of names) {
    const text = readText(join(root, name, 'SKILL.md'));
    if (text === null) continue;
    const seen = new Set();
    for (const line of text.split(/\r?\n/)) {
      const m = MODEL_LINE_RE.exec(line);
      if (!m) continue;
      const id = cleanId(m[1]);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(finding(`scheduled task ${name}`, id, { surface: 'scheduled-task' }, cfg));
    }
  }
  return out;
}

// 3. Settings files. `files` = [{ label, path }].
export function scanSettings(files, cfg = modelTiers()) {
  const out = [];
  for (const f of files) {
    const text = readText(f.path);
    if (text === null) continue;
    let json;
    try { json = JSON.parse(text.replace(/^﻿/, '')); } catch { continue; }
    const fields = [['model', json?.model], ['env ANTHROPIC_MODEL', json?.env?.ANTHROPIC_MODEL], ['env CLAUDE_CODE_SUBAGENT_MODEL', json?.env?.CLAUDE_CODE_SUBAGENT_MODEL]];
    for (const [field, value] of fields) {
      const id = typeof value === 'string' ? pinnedIdIn(value) : null;
      if (id) out.push(finding(`${f.label} ${field}`, id, { surface: 'settings' }, cfg));
    }
  }
  return out;
}

// 4. Agent definitions: frontmatter `model:` of every *.md in `dir`.
export function scanAgentDir(dir, label, cfg = modelTiers()) {
  const out = [];
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).slice(0, MAX_AGENT_FILES); } catch { return out; }
  for (const f of files) {
    const text = readText(join(dir, f));
    if (text === null) continue;
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;
    const line = fm[1].split(/\r?\n/).find((l) => /^model:/.test(l));
    if (!line) continue;
    const id = pinnedIdIn(line.replace(/^model:\s*/, ''));
    if (id) out.push(finding(`${label} agent ${f}`, id, { surface: 'agent' }, cfg));
  }
  return out;
}

// Everything above, over the usual places. `projects` = project root paths.
export function scanPinnedModels({ claudeDirPath, projects = [], cfg = modelTiers() } = {}) {
  const found = [...scanTierData(cfg)];
  if (claudeDirPath) {
    found.push(...scanScheduledTasks(claudeDirPath, cfg));
    found.push(...scanSettings([{ label: 'user settings', path: join(claudeDirPath, 'settings.json') }], cfg));
    found.push(...scanAgentDir(join(claudeDirPath, 'agents'), 'user', cfg));
  }
  for (const p of projects) {
    // The home directory is a "project" too (its .claude IS the user dir): scanned once, above.
    if (claudeDirPath && resolve(join(p, '.claude')).toLowerCase() === resolve(claudeDirPath).toLowerCase()) continue;
    const tag = `project ${basename(p)}`;
    found.push(...scanSettings([
      { label: `${tag} settings`, path: join(p, '.claude', 'settings.json') },
      { label: `${tag} local settings`, path: join(p, '.claude', 'settings.local.json') },
    ], cfg));
    if (existsSync(join(p, '.claude', 'agents'))) found.push(...scanAgentDir(join(p, '.claude', 'agents'), tag, cfg));
  }
  // One finding per (where, id).
  const seen = new Set();
  return found.filter((f) => { const k = `${f.where}|${f.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Stable identity of a finding, for the scout's "new since last run" test.
export const findingKey = (f) => `${f.where}|${f.id}`;
