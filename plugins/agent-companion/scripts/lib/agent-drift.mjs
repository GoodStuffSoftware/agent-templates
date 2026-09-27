// Project-agent drift: compare a project's own agent definitions
// (.claude/agents/*.md) against the routing table.
//
// An agent opts in with one frontmatter key, `routingType: <task type>`
// (a key from config/model-tiers.json's taskTypes, e.g. debug-root-cause).
// Claude Code ignores a frontmatter field it does not recognise: its
// sub-agents reference says "Claude Code ignores a field it doesn't
// recognize without reporting an error" (code.claude.com/docs/en/sub-agents),
// so the key costs the agent nothing at load time.
//
// For each mapped agent the definition's model/effort is compared with
// resolveRoute({ type }) (shipped table only, profile: false — one machine's
// routing profile must not decide whether a committed file has drifted):
//   below   the definition is a lower model tier, or the same tier at a lower effort
//   above   the reverse
//   match   same tier and effort (or the route takes no effort)
//   inherits  the route has an effort and the definition sets none, so the
//           agent runs at whatever effort its caller's session has
//   unknown-type  routingType names no task type in the table
//   parity  routingType names a parity type (code-review): sized to its
//           writer, not to the table, and checked by the coverage rule below
// Agents with no routingType are UNMAPPED — listed, never a failure.
//
// Parity coverage (only when the project has a routingType: code-review
// agent): every WRITER agent — a mapped agent whose type writes changes (not
// a read-only or diagnostic type, see READ_ONLY_TYPES) — needs a reviewer
// agent on the SAME model tier at an equal or higher effort
// (config/model-tiers.json reviewerParity: modelMustMatch, effortMayNotDrop).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolveRoute, classifyModel, classifyEffort, taskTypeDef } from '../../hooks/lib/context.mjs';

// Types whose agents do not write the change a reviewer gates.
export const READ_ONLY_TYPES = new Set(['explore', 'verify', 'debug-root-cause', 'operate', 'code-review']);

export function parseFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return out;
}

export function readProjectAgents(projectDir) {
  const dir = join(projectDir, '.claude', 'agents');
  if (!existsSync(dir)) return [];
  const out = [];
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
  for (const f of files) {
    let fm = {};
    try { fm = parseFrontmatter(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    out.push({
      name: fm.name || f.replace(/\.md$/, ''),
      rel: join(basename(dir), f),
      model: fm.model || '',
      effort: fm.effort || '',
      routingType: fm.routingType || '',
    });
  }
  return out;
}

function compare(agent, route) {
  const am = classifyModel(agent.model);
  const rm = classifyModel(route.model);
  if (!agent.model) return 'below-unpinned';
  if (am.rank !== rm.rank) return am.rank < rm.rank ? 'below' : 'above';
  if (!route.effort) return 'match';
  if (!agent.effort) return 'inherits';
  const ae = classifyEffort(agent.effort).rank;
  const re = classifyEffort(route.effort).rank;
  if (ae === re) return 'match';
  return ae < re ? 'below' : 'above';
}

const label = (m, e) => `${m || '(inherited)'}${e ? `/${e}` : ''}`;

// { agents: [{...agent, verdict, route}], unmapped: [name], parityGaps: [{writer, need}] }
export function projectAgentDrift(projectDir, { agents = readProjectAgents(projectDir) } = {}) {
  const out = { agents: [], unmapped: [], parityGaps: [] };
  for (const a of agents) {
    if (!a.routingType) { out.unmapped.push(a.name); continue; }
    const td = taskTypeDef(a.routingType, { profile: false });
    if (!td) { out.agents.push({ ...a, verdict: 'unknown-type', route: null }); continue; }
    if (td.def.weight === 'parity') { out.agents.push({ ...a, verdict: 'parity', route: null }); continue; }
    const r = resolveRoute({ type: a.routingType, profile: false });
    if (!r || !r.model) { out.agents.push({ ...a, verdict: 'unknown-type', route: null }); continue; }
    const route = { model: r.model, effort: r.effort || '' };
    out.agents.push({ ...a, verdict: compare(a, route), route });
  }
  const reviewers = out.agents.filter((a) => a.verdict === 'parity');
  if (reviewers.length) {
    const writers = out.agents.filter((a) => a.route && !READ_ONLY_TYPES.has(a.routingType));
    for (const w of writers) {
      const wm = classifyModel(w.model);
      const we = classifyEffort(w.effort).rank;
      const ok = reviewers.some((r) => r.model && classifyModel(r.model).rank === wm.rank
        && classifyEffort(r.effort).rank >= we);
      if (!ok) out.parityGaps.push({ writer: w.name, need: `${wm.alias || w.model || '(inherited)'} at effort >= ${w.effort || '(inherited)'}` });
    }
  }
  return out;
}

// Human-readable findings for the audit. Unmapped agents come back as one
// `info:` line, which the agent-defs check does not count toward its status.
export function driftFindings(d) {
  const f = [];
  for (const a of d.agents) {
    if (a.verdict === 'below' || a.verdict === 'above') {
      f.push(`${a.rel}: routingType ${a.routingType} routes to ${label(a.route.model, a.route.effort)}; this definition is ${label(a.model, a.effort)} — ${a.verdict} the table`);
    } else if (a.verdict === 'below-unpinned') {
      f.push(`${a.rel}: routingType ${a.routingType} routes to ${label(a.route.model, a.route.effort)}; this definition names no model — below the table (inherits the lead's)`);
    } else if (a.verdict === 'inherits') {
      f.push(`${a.rel}: routingType ${a.routingType} routes to ${label(a.route.model, a.route.effort)}; this definition sets no effort, so it inherits its caller's`);
    } else if (a.verdict === 'unknown-type') {
      f.push(`${a.rel}: routingType "${a.routingType}" is not a task type in config/model-tiers.json`);
    }
  }
  for (const g of d.parityGaps) {
    f.push(`reviewer parity: writer ${g.writer} has no routingType: code-review agent at ${g.need}`);
  }
  if (d.unmapped.length) {
    f.push(`info: ${d.unmapped.length} agent(s) carry no routingType and are not checked against the routing table: ${d.unmapped.join(', ')}`);
  }
  return f;
}

export function driftCounts(d) {
  const n = (v) => d.agents.filter((a) => a.verdict === v).length;
  return {
    mapped: d.agents.length,
    match: n('match'),
    below: n('below') + n('below-unpinned'),
    above: n('above'),
    inherits: n('inherits'),
    unknownType: n('unknown-type'),
    parityGaps: d.parityGaps.length,
    unmapped: d.unmapped.length,
  };
}
