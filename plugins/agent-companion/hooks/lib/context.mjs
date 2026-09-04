// Shared helpers for agent-companion hooks.
//
// Design rule that outranks every feature here: A HOOK MUST NEVER BREAK A SESSION.
// Every guard fails OPEN. If we cannot parse the payload, cannot read state, or
// cannot positively confirm we are on the main thread, we allow the call. The
// cost of under-enforcing is a missed nudge; the cost of over-enforcing is a
// wedged agent. The daily calibration routine is what catches under-enforcement.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// Agent types observed in the shipped binary (2.1.220). The binary tests the
// main thread with `agentType === "main"`, but mainThreadAgentType is settable
// at runtime, so we treat this as an allowlist rather than a guarantee.
export const MAIN_THREAD_TYPES = new Set(['main', 'main-session']);
export const KNOWN_AGENT_TYPES = new Set([
  'main', 'main-session', 'subagent', 'teammate', 'worker',
  'workflow-subagent', 'general-purpose', 'claude', 'statusline-setup',
  'Explore', 'Plan', 'claude-code-guide',
]);

// Premium tiers. Fable is deliberately NOT banned — it is capped and audited.
// Model tiers are DATA, loaded from config/model-tiers.json and overridable at
// $CLAUDE_PLUGIN_DATA/model-tiers.json. A tier table baked into code goes stale
// the moment a lineup changes, and it goes stale SILENTLY - the guards keep
// running and simply stop classifying correctly. This work began by fixing a
// routing table that had been wrong for a whole model generation; hardcoding
// the same knowledge here would rebuild that trap one layer down.
let _tiers = null;
export function modelTiers() {
  if (_tiers) return _tiers;
  const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'model-tiers.json');
  let cfg = { tiers: {}, unknownIsPremium: true };
  try { cfg = JSON.parse(readFileSync(shipped, 'utf8')); } catch { /* use defaults */ }
  // The override merges BY ALIAS, so adding one model does not require
  // restating the table - a table you must retype is one you will not update.
  try {
    const over = JSON.parse(readFileSync(join(dataDir(), 'model-tiers.json'), 'utf8'));
    cfg = { ...cfg, ...over, tiers: { ...(cfg.tiers || {}), ...(over.tiers || {}) } };
  } catch { /* no override: expected */ }
  _tiers = cfg;
  return _tiers;
}

// Returns { alias, rank, premium, known }. An unrecognised model reports
// known:false so callers can flag it instead of quietly bucketing it.
export function classifyModel(model) {
  const cfg = modelTiers();
  const m = String(model || '');
  for (const [alias, spec] of Object.entries(cfg.tiers || {})) {
    if (m && new RegExp(spec.match || alias, 'i').test(m)) {
      return { alias, rank: spec.rank ?? 0, premium: !!spec.premium, known: true };
    }
  }
  // Fail toward the EXPENSIVE assumption. Treating an unknown model as cheap
  // would let a newly released top tier bypass the warrant and the cap during
  // exactly the window in which nobody has updated the table yet.
  return { alias: '', rank: 0, premium: cfg.unknownIsPremium !== false, known: false };
}

// Effort is a separate axis from model and scales ALL output - thinking,
// answer, and tool calls alike. Ranking it lets the audit compare two agents'
// effort the way it compares their tiers, which is what the reviewer-parity
// rule needs: effort may exceed the writer's, and must never fall below it.
export function classifyEffort(effort) {
  const cfg = modelTiers();
  const e = String(effort || '').toLowerCase();
  const spec = (cfg.efforts || {})[e];
  return spec ? { level: e, rank: spec.rank ?? 0, known: true }
              : { level: e, rank: 0, known: false };
}

// Weight (1-5) -> the model and effort that weight routes to. Data, so the
// routing table can be corrected without shipping code.
export function routeForWeight(weight) {
  const cfg = modelTiers();
  return (cfg.routing || {})[String(weight)] || null;
}

// An entry may be classified but not reachable on this account. Pinning an
// agent to one fails at spawn time with nothing having warned beforehand.
export function isModelAvailable(model) {
  const cfg = modelTiers();
  const m = String(model || '');
  for (const [alias, spec] of Object.entries(cfg.tiers || {})) {
    if (m && new RegExp(spec.match || alias, 'i').test(m)) return spec.available !== false;
  }
  return true; // unknown models are flagged elsewhere, not blocked here
}
// Effort availability is PER MODEL, not global. xhigh only exists from the
// 4.7 generation onward, and haiku takes no effort parameter at all - so a
// haiku agent carrying `effort: low` is not asking for less thinking, it is
// setting a parameter the model does not accept. Returns:
//   { ok, supported[], reason }
export function effortSupported(model, effort) {
  const cfg = modelTiers();
  const m = String(model || '');
  const e = String(effort || '').toLowerCase();
  if (!e) return { ok: true, supported: [], reason: 'no effort set' };
  for (const [alias, spec] of Object.entries(cfg.tiers || {})) {
    if (m && new RegExp(spec.match || alias, 'i').test(m)) {
      const list = Array.isArray(spec.efforts) ? spec.efforts : null;
      if (!list) return { ok: true, supported: [], reason: 'tier declares no effort set' };
      if (list.length === 0) {
        return { ok: false, supported: [], reason: `${alias} takes no effort parameter` };
      }
      return list.includes(e)
        ? { ok: true, supported: list, reason: '' }
        : { ok: false, supported: list, reason: `${alias} supports ${list.join(', ')}` };
    }
  }
  return { ok: true, supported: [], reason: 'unknown model' };
}
// Decide the effort, rather than leaving it to taste.
//
// Weight picks the MODEL - how much capability the task needs. Kind adjusts
// the EFFORT - how much the answer benefits from search. They are genuinely
// orthogonal: a routing table and a message bus can touch the same number of
// files and deserve completely different amounts of thinking, because one has
// a single right shape and the other has an answer space to explore.
//
// Returns { model, effort, rationale } and clamps to what the model accepts,
// so a haiku route comes back with no effort at all rather than a parameter
// that model does not take.
function tierRank(alias) {
  const cfg = modelTiers();
  return (cfg.tiers || {})[alias]?.rank ?? 0;
}

export function effortFor(weight, kind = 'bounded', consequence = 'routine') {
  const cfg = modelTiers();
  const route = (cfg.routing || {})[String(weight)];
  if (!route) return { model: '', effort: '', rationale: `no routing row for weight ${weight}` };

  // Resolve the consequence MODEL floor before anything else. It used to be
  // applied last, after the effort computation — and a tier with no effort
  // parameter (haiku) returned early from that computation, skipping the floor
  // entirely. So a one-line production migration at weight 2 came back as
  // haiku. That is the exact case the consequence axis exists for.
  const cons = (cfg.consequence || {})[consequence] || {};
  const modelFloored = !!(cons.modelFloor && tierRank(cons.modelFloor) > tierRank(route.model));
  const model = modelFloored ? cons.modelFloor : route.model;
  const lifted = modelFloored ? `; ${consequence} consequence raises the model to ${model}` : '';
  const routeLabel = `${route.model}${route.effort ? '/' + route.effort : ''}`;

  const tier = (cfg.tiers || {})[model] || {};
  const supported = Array.isArray(tier.efforts) ? tier.efforts : [];
  if (supported.length === 0) {
    return {
      model,
      effort: '',
      rationale: `weight ${weight} routes to ${routeLabel}${lifted}; ${model} takes no effort parameter`,
    };
  }

  const delta = (cfg.taskKinds || {})[kind]?.effortDelta ?? 0;
  const ranked = Object.entries(cfg.efforts || {})
    .sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0))
    .map(([name]) => name)
    .filter((name) => supported.includes(name));

  // A floored model has no base effort from the route — the route's effort was
  // for a different tier — so start from the bottom and let the floors lift it.
  const baseIdx = modelFloored ? 0 : Math.max(0, ranked.indexOf(route.effort));
  // Clamp rather than error: a kind that pushes past the top means 'as much as
  // this model has', which is a real answer, not a failed lookup.
  const idx = Math.min(ranked.length - 1, Math.max(0, baseIdx + delta));

  // Consequence EFFORT floor, applied after the kind delta so it cannot be
  // undercut. Difficulty and consequence are close to orthogonal: without this
  // the -1 for mechanical work would reduce thinking on exactly the change
  // least able to absorb a mistake.
  let finalIdx = idx;
  if (cons.effortFloor) {
    const floorIdx = ranked.indexOf(cons.effortFloor);
    if (floorIdx > finalIdx) finalIdx = floorIdx;
  }
  const effortFinal = ranked[finalIdx];

  const moved = idx - baseIdx;
  const why = moved === 0
    ? `${kind} work needs no adjustment`
    : `${kind} work shifts effort ${moved > 0 ? 'up' : 'down'} ${Math.abs(moved)}`;
  const floored = finalIdx > idx ? `; ${consequence} consequence raises the floor to ${effortFinal}` : '';
  return {
    model,
    effort: effortFinal,
    rationale: `weight ${weight} routes to ${routeLabel}${lifted}; ${why}${floored} -> ${model}/${effortFinal}`,
  };
}
export function readStdin() {
  try {
    let raw = readFileSync(0, 'utf8') || '';
    // PowerShell prepends a UTF-8 BOM to piped stdin on Windows. Without this
    // strip, JSON.parse throws, the caller's fail-open catch swallows it, and
    // the hook silently does nothing — indistinguishable from "no issues
    // found". Documented in the library as powershell-pipe-bom-breaks-json.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    raw = raw.trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const DATA_ROOT = join(homedir(), '.claude', 'plugins', 'data');

// Inside a hook the harness sets CLAUDE_PLUGIN_DATA and this is exact. The
// fallback matters for READERS — the audit, the doctor, the scout — which run
// outside a hook. It previously guessed `data/agent-companion`, but the real
// convention is `data/<plugin>-<marketplace>`, so every reader was scanning a
// directory that did not exist and reporting a clean bill of health against
// nothing at all. A silent wrong answer, which is the failure this plugin is
// supposed to catch, not commit.
export function dataDir() {
  const d = process.env.CLAUDE_PLUGIN_DATA || preferredDataDir()
    || join(DATA_ROOT, 'agent-companion-agent-templates');
  try { mkdirSync(d, { recursive: true }); } catch { /* fail open */ }
  return d;
}

// Outside a hook there is no CLAUDE_PLUGIN_DATA, and "first directory
// alphabetically" is the wrong guess: a stray bare `agent-companion/` sorts
// ahead of the `agent-companion-<marketplace>/` the hooks actually write to,
// and a script that lands there reports zero spawns with a straight face.
// Prefer the directory the hooks have most recently written telemetry into.
function preferredDataDir() {
  const dirs = dataDirs();
  if (dirs.length === 0) return null;
  let best = null;
  let bestAt = -1;
  for (const d of dirs) {
    try {
      const at = statSync(join(d, 'spawns.jsonl')).mtimeMs;
      if (at > bestAt) { best = d; bestAt = at; }
    } catch { /* no telemetry here */ }
  }
  if (best) return best;
  // No telemetry anywhere yet: prefer a marketplace-shaped dir over bare/inline.
  return dirs.find((d) => /agent-companion-(?!inline$)/.test(d)) || dirs[0];
}

// The same plugin can accumulate SEVERAL data directories — one per marketplace
// it was loaded from, plus `-inline` for a dev/--plugin-dir load. Telemetry
// splits across them, so a reader that looks at only one under-reports without
// any sign that it did. Readers should aggregate across all of them.
export function dataDirs() {
  try {
    return readdirSync(DATA_ROOT)
      .filter((d) => d === 'agent-companion' || d.startsWith('agent-companion-'))
      .map((d) => join(DATA_ROOT, d))
      .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
  } catch {
    return [];
  }
}

// userConfig keys surface as CLAUDE_PLUGIN_OPTION_<KEY> env vars.
export function opt(key, fallback) {
  const raw = process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  if (raw === undefined || raw === '') return fallback;
  if (typeof fallback === 'boolean') return !/^(false|0|no|off)$/i.test(raw);
  if (typeof fallback === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  return raw;
}

// Positive confirmation only. Unknown or missing => NOT main => no enforcement.
export function isMainThread(p) {
  return typeof p.agent_type === 'string' && MAIN_THREAD_TYPES.has(p.agent_type);
}

// Look up a named agent's own definition. This is what distinguishes a
// PROJECT-DEFINED agent from genuine harness drift, and a configured model from
// an unexamined default — the two things the raw payload cannot tell apart.
export function agentDefinition(type, cwd) {
  if (!type) return null;
  const roots = [
    cwd && join(cwd, '.claude', 'agents'),
    join(homedir(), '.claude', 'agents'),
  ].filter(Boolean);
  for (const root of roots) {
    const file = join(root, `${type}.md`);
    try {
      if (!existsSync(file)) continue;
      const m = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) return { file, model: '', effort: '' };
      const fm = {};
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (kv) fm[kv[1]] = kv[2].trim();
      }
      return { file, model: fm.model || '', effort: fm.effort || '' };
    } catch { /* keep looking */ }
  }
  return null;
}

// Enforcement fails open on unknown types, but detection must not. Record them
// so the daily scout can dispatch a harness-surface review.
//
// Two refinements learned from real data: a type with its own definition file
// is a PROJECT-DEFINED agent, not drift — recording those buried the real signal
// under a project's own roster. And the same type was appended dozens of times
// in an afternoon; drift is a set, not a stream, so each type is recorded once.
export function noteAgentType(p) {
  const t = p.agent_type;
  if (!t || KNOWN_AGENT_TYPES.has(t)) return;
  if (agentDefinition(t, p.cwd)) return; // defined somewhere: known, not drift
  try {
    const f = join(dataDir(), 'unknown-agent-types.jsonl');
    let seen = '';
    try { seen = readFileSync(f, 'utf8'); } catch { /* first one */ }
    if (seen.includes(`"agent_type":"${t}"`)) return;
    writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), agent_type: t }) + '\n', { flag: 'a' });
  } catch { /* fail open */ }
}

export function isPremium(model) {
  if (!model) return false; // nothing named: the inheritance path handles it
  return classifyModel(model).premium;
}

export function stateFile(name) {
  return join(dataDir(), name);
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  try { writeFileSync(file, JSON.stringify(value)); } catch { /* fail open */ }
}

// Emitted telemetry is a PUBLIC CONTRACT, not an internal detail — other tools
// read these files. Every record carries the schema version that produced it, so
// a consumer can skip records from a major version it does not understand
// instead of silently misreading them. Consumers must tolerate unknown fields.
// See docs/TELEMETRY.md.
export const TELEMETRY_SCHEMA = 1;

export function appendLog(name, record) {
  try {
    const stamped = { v: TELEMETRY_SCHEMA, ...record };
    writeFileSync(stateFile(name), JSON.stringify(stamped) + '\n', { flag: 'a' });
  } catch { /* fail open */ }
}

// Record a guard firing. Without this the denial count is always zero, and a
// guard that has silently stopped matching is indistinguishable from one with
// nothing to deny — which is exactly the signal the calibration canary exists
// to raise. Call this BEFORE deny(), which exits the process.
export function recordDenial(guard, payload, detail) {
  const sid = String(payload?.session_id ?? '');
  if (sid.startsWith('canary')) return; // probes must not inflate their own metric
  appendLog('denials.jsonl', {
    at: new Date().toISOString(),
    session_id: sid,
    agent_type: payload?.agent_type,
    guard,
    outcome: 'deny',
    detail: String(detail ?? '').slice(0, 300),
  });
}

export function allow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  }));
  process.exit(0);
}

export function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// Exit silently without a decision — the call proceeds normally.
export function passthrough() { process.exit(0); }
