// init --from-register: propose the user layer of the usage analysis (design 3.7).
//
// Pure except for the reads and the one guarded write in runInit. The proposal is built from the
// decision register (decision-register.json under the config dir): a window opens at
// `decision:<id>` for each recognised decision. Nothing machine-specific is invented: no session ids,
// no plan size. The operator edits the file afterwards.
//
// The proposal never names an event the operator's files do not have. Rollout rows are read from
// <root>/rollout.json:
//   * the leads-high window opens at `rollout:leads-high` (measured instant) when that row exists, else at
//     the register decision (`decision:<id>`, always present because it comes from the register);
//   * the xhigh side of the leads comparison needs `rollout:leads-xhigh`; when that row is absent the xhigh
//     window and the scenario built on it are left out. The scenario is kept under a `$commented-out` key
//     with a one-line reason, so adding the row and moving the block back is all it takes.
//
//   absent file  -> written (atomically), nothing else touched
//   file exists  -> never written; a line diff (existing -> proposal) is returned

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadRegister, registerPath } from '../decision-register.mjs';
import { userConfigPath, validateLayer } from './config.mjs';
import { loadEventSources } from './events.mjs';
import { writeTextAtomic } from '../../../hooks/lib/context.mjs';

const SCHEMA = 'agent-companion/usage-analysis';

const idsOf = (register) => (register && Array.isArray(register.decisions) ? register.decisions.map((d) => d && d.id).filter((x) => typeof x === 'string') : []);

const LEADS_XHIGH_ROLLOUT = 'leads-xhigh';
const LEADS_HIGH_ROLLOUT = 'leads-high';

/**
 * @param {object} register   the parsed decision register
 * @param {object} [o]
 * @param {Set<string>|null} [o.rolloutIds]  the rollout ids that have an instant in <root>/rollout.json;
 *                                           null/absent = no rollout row exists
 */
export function buildProposal(register, { rolloutIds = null } = {}) {
  const ids = idsOf(register);
  const find = (re) => ids.find((id) => re.test(id));
  const windows = {};
  const leads = find(/lead.*(effort|high|xhigh)/i);
  const hasXhighRollout = !!(rolloutIds && rolloutIds.has(LEADS_XHIGH_ROLLOUT));
  const hasHighRollout = !!(rolloutIds && rolloutIds.has(LEADS_HIGH_ROLLOUT));
  if (leads) {
    windows['leads-high'] = hasHighRollout
      ? { from: `rollout:${LEADS_HIGH_ROLLOUT}`, label: 'M', why: 'lead effort set to high (rollout row)' }
      : { from: `decision:${leads}`, label: 'E', why: 'lead effort set to high (from the register)' };
    if (hasXhighRollout) {
      windows['leads-high'].to = `rollout:${LEADS_XHIGH_ROLLOUT}`;
      windows['leads-xhigh'] = { from: `rollout:${LEADS_XHIGH_ROLLOUT}`, label: 'E', why: 'lead effort set to xhigh' };
    }
  }
  const haiku = find(/haiku.*trial/i);
  if (haiku) windows['haiku-trial'] = { from: `decision:${haiku}`, label: 'E', why: 'Haiku trial (from the register)' };

  const exclusions = {
    'fable-tree': { model: ['claude-fable-*'], scope: 'tree', why: 'design sessions on a heavier model; the weight is an estimate' },
    'bus-sessions': { titleAny: ['bus'], scope: 'tree', why: 'bus-related coordination sessions, not lead work' },
    'stray-tests': { rule: 'noDesktopRecordAndPromptsAtMost1', why: 'throwaway test sessions' },
  };
  const scenarios = [];
  const commentedOut = {};
  const leadsScenario = () => ({
      id: 'u.leadsXhighVsHigh',
      title: 'Lead units per prompt, xhigh against high',
      metric: 'lead.unitsPerPrompt',
      cohort: { class: ['lead'] },
      excludeSets: ['fable-tree', 'bus-sessions', 'stray-tests'],
      compare: [{ window: 'leads-xhigh', vs: 'leads-high' }],
      groupBy: 'effortObserved',
      threshold: { direction: 'up-is-worse', relPct: 20, minSample: 25, interval: 'bootstrap-sessions' },
      severity: 'info',
      cadence: 'daily',
    });
  if (windows['leads-high'] && windows['leads-xhigh']) scenarios.push(leadsScenario());
  else if (leads) {
    commentedOut.reason = `u.leadsXhighVsHigh is off: rollout.json has no "${LEADS_XHIGH_ROLLOUT}" row, so the xhigh window has no start; add the row, add the leads-xhigh window and move this scenario into scenarios`;
    commentedOut.scenario = leadsScenario();
  }
  if (windows['haiku-trial']) {
    scenarios.push({
      id: 'u.haikuTrialSpawns',
      title: 'Haiku trial: units per spawn before and after',
      metric: 'spawn.unitsPerSpawn',
      cohort: { modelFamily: ['haiku'] },
      compare: [{ window: 'haiku-trial', vs: 'pre-window' }],
      severity: 'info',
    });
  }
  return {
    $comment: 'Proposed by usage-analysis init --from-register. Edit freely; precedence is user > project > shipped. Set environment.plan.weeklyLimitUnits to your plan. Decide separately whether a session you do not count as lead work needs a sessionId exclusion.',
    schema: SCHEMA,
    schemaVersion: 1,
    revision: 1,
    environment: { projects: { autoload: true } },
    windows,
    exclusions,
    scenarios,
    ...(commentedOut.scenario ? { '$commented-out': commentedOut } : {}),
  };
}

const lines = (s) => s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

// Line diff (LCS). '-' = only in the existing file, '+' = only in the proposal, two spaces = both.
export function lineDiff(a, b) {
  const x = lines(a); const y = lines(b);
  const m = x.length; const n = y.length;
  const t = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) for (let j = n - 1; j >= 0; j -= 1) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) { out.push(`  ${x[i]}`); i += 1; j += 1; } else if (t[i + 1][j] >= t[i][j + 1]) { out.push(`- ${x[i]}`); i += 1; } else { out.push(`+ ${y[j]}`); j += 1; }
  }
  while (i < m) { out.push(`- ${x[i]}`); i += 1; }
  while (j < n) { out.push(`+ ${y[j]}`); j += 1; }
  return out;
}

/** Returns { action: 'wrote'|'would-write'|'diff'|'identical'|'no-register', path, text?, diff?, problems? }. Never throws. */
export function runInit({ root, registerFile = registerPath(), dryRun = false } = {}) {
  const path = userConfigPath(root);
  try {
    const reg = loadRegister(registerFile);
    if (!reg.ok) {
      return { action: 'no-register', path, error: reg.absent ? `no decision register at ${String(registerFile).replace(/\\/g, '/')}` : `decision register is invalid: ${(reg.errors || []).join('; ')}` };
    }
    const sources = loadEventSources(root);
    const rolloutIds = new Set([LEADS_XHIGH_ROLLOUT, LEADS_HIGH_ROLLOUT].filter((id) => sources.rolloutMs(id) !== null));
    const proposal = buildProposal(reg.register, { rolloutIds });
    const text = `${JSON.stringify(proposal, null, 2)}\n`;
    const rec = validateLayer(proposal, 'user');
    const problems = [...rec.errors, ...rec.refusals].map((e) => `${e.path}: ${e.message}`);
    if (existsSync(path)) {
      let cur = '';
      try { cur = readFileSync(path, 'utf8').replace(/^﻿/, ''); } catch { /* shown as empty */ }
      if (cur === text) return { action: 'identical', path, problems };
      return { action: 'diff', path, text, diff: lineDiff(cur, text), problems };
    }
    if (!dryRun) { mkdirSync(dirname(path), { recursive: true }); writeTextAtomic(path, text); }
    return { action: dryRun ? 'would-write' : 'wrote', path, text, problems };
  } catch (e) {
    return { action: 'no-register', path, error: String((e && e.message) || e).slice(0, 200) };
  }
}
