// Deterministic signal detection for the daily calibration scout.
//
// Everything here is a hash, a count, or a diff — no model judgement. That is
// deliberate: if an LLM decides from keywords whether something changed, the
// triggering becomes nondeterministic, and a scout that silently misses a signal
// is WORSE than a fixed cadence, because you believe you are covered.
//
// The model's job starts where this script ends: read these signals, decide
// which heavy routine is warranted, write the summary.
//
// Emits JSON to stdout: { changed: bool, signals: [...], baseline: {...} }

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { modelTiers } from '../hooks/lib/context.mjs';

const dataDir = process.env.CLAUDE_PLUGIN_DATA
  || join(homedir(), '.claude', 'plugins', 'data', 'agent-companion');
try { mkdirSync(dataDir, { recursive: true }); } catch {}

const baselineFile = join(dataDir, 'baseline.json');
const baseline = existsSync(baselineFile)
  ? JSON.parse(readFileSync(baselineFile, 'utf8'))
  : {};

const signals = [];
const now = new Date().toISOString();
const next = { checkedAt: now };

function sig(kind, detail, dispatch) {
  signals.push({ kind, detail, dispatch });
}

// --- 1. Harness version ------------------------------------------------
// The highest-value check. A renamed matcher or a new hook event does not
// error — the guards just stop firing, silently.
try {
  const v = execSync('claude --version', { encoding: 'utf8', timeout: 20000 }).trim();
  next.version = v;
  if (baseline.version && baseline.version !== v) {
    sig('harness_version_changed', `${baseline.version} -> ${v}`,
      'harness-surface-diff + guardrail-canary');
  }
} catch {
  next.version = baseline.version ?? null;
  sig('harness_version_unreadable', 'could not run `claude --version`', 'manual-check');
}

// --- 2. Unknown agent types -------------------------------------------
// Enforcement fails open on these by design; detection must not.
const unknownFile = join(dataDir, 'unknown-agent-types.jsonl');
if (existsSync(unknownFile)) {
  const types = [...new Set(
    readFileSync(unknownFile, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l).agent_type; } catch { return null; } })
      .filter(Boolean)
  )];
  const seen = new Set(baseline.knownUnknowns || []);
  const fresh = types.filter((t) => !seen.has(t));
  next.knownUnknowns = types;
  if (fresh.length) {
    sig('new_agent_type', `unrecognised agent_type(s): ${fresh.join(', ')}`,
      'harness-surface-diff');
  }
}

// --- 3. Spawn + guardrail activity ------------------------------------
function readJsonl(name) {
  const f = join(dataDir, name);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const spawns = readJsonl('spawns.jsonl');
const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
const recent = spawns.filter((s) => Date.parse(s.at) > dayAgo);
const premium = recent.filter((s) => /fable|opus/i.test(s.model || ''));
const inherited = recent.filter((s) => s.model === '(inherited)');

next.spawnTotal = spawns.length;
if (recent.length) {
  sig('spawn_activity',
    `${recent.length} spawns/24h; ${premium.length} premium; ${inherited.length} with no explicit model`,
    premium.length > (baseline.premiumPerDay ?? 0) * 2 ? 'spend-deep-dive' : 'none');
}
next.premiumPerDay = premium.length;

// Inherited-model spawns are the exact mechanism behind unexamined premium
// fan-out: nothing chose the tier, the lead's model did.
if (inherited.length > 0) {
  sig('inherited_model_spawns',
    `${inherited.length} spawn(s) in 24h specified no model and inherited the lead's tier`,
    'routing-review');
}

// --- 4. Silent-failure canary -----------------------------------------
// A guard that stopped matching looks identical to one never tripped.
// Zero denials across a week of real spawn activity is a signal, not good news.
const denialFile = join(dataDir, 'denials.jsonl');
const denials = existsSync(denialFile) ? readJsonl('denials.jsonl') : [];
const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
const recentDenials = denials.filter((d) => Date.parse(d.at) > weekAgo);
const weekSpawns = spawns.filter((s) => Date.parse(s.at) > weekAgo);
if (weekSpawns.length > 20 && recentDenials.length === 0) {
  sig('zero_denials',
    `${weekSpawns.length} spawns in 7d and zero guard denials — guards may have stopped matching`,
    'guardrail-canary');
}

// --- 5. Model retirement ------------------------------------------------
// A tier alias that retires does not error; it resolves to whatever replaces
// it, or to nothing. Either way the routing table is silently wrong from that
// day. Warn inside a window wide enough to decide the replacement first.
const RETIRE_WARN_DAYS = 60;
try {
  const cfg = modelTiers();
  for (const [alias, spec] of Object.entries(cfg.tiers || {})) {
    if (!spec.retiresAfter) continue;
    const days = Math.floor((Date.parse(spec.retiresAfter) - Date.now()) / 86400000);
    if (days <= RETIRE_WARN_DAYS) {
      sig('model_retirement_approaching',
        `${alias} retires ${days < 0 ? Math.abs(days) + ' days AGO' : 'in ' + days + ' days'} (${spec.retiresAfter}) — routing rows on this alias need a replacement decided`,
        'routing-review');
    }
  }
} catch { /* config unreadable: the audit reports that separately */ }

writeFileSync(baselineFile, JSON.stringify({ ...baseline, ...next }, null, 2));

process.stdout.write(JSON.stringify({
  changed: signals.length > 0,
  checkedAt: now,
  signals,
  baseline: next,
}, null, 2));
