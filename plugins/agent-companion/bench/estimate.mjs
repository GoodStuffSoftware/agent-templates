// Pre-run cost/time estimate for the model x effort benchmark, and the
// confirmation gate that guards a real run behind it.
//
// SHARED MODULE, deliberately: ADR 0003 slice 6 (git fix-commit mining)'s own
// dry run needs the exact same "cell x task -> wall time / tokens / $ /
// weekly-plan-points" arithmetic this file provides for
// `scripts/benchmark.mjs --dry-run`/a live run's pre-flight print. Nothing
// here is specific to the built-in TASKS map -- callers hand it a `plan`
// (an array of { family, model, effort } rows, however they got there) and
// get back one estimate shape, whether the plan came from
// bench/runner.mjs's CELLS x TASKS x reps or from a mining dry run's own
// candidate list.
//
// Zero model calls, ever. Every number here comes from EITHER the shipped
// seed (bench/config/estimate-seed.json, computed once from this operator's
// own local history and committed as numbers only -- see that file's own
// `note`) or this machine's OWN local results.jsonl history
// (loadLocalHistory()), which always wins when it has data for a cell.
//
// "Points" here means the plan's weekly/5-hour usage-window points, the same
// currency skills/model-benchmark/SKILL.md's "+10 points" ceiling and
// team-orchestration's cost table already use -- NOT a percentage, though
// this file treats 1 point as interchangeable with 1 percentage point of the
// weekly window for the purpose of projecting "current % + this run's
// points" into a projected %. That equivalence is an ASSUMPTION (there is no
// public documentation of the plan's metering), stated once here rather than
// silently baked into the math -- see formatEstimate()'s footer.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyModel, classifyReferenceModel, dataDir, modelTiers,
} from "../hooks/lib/context.mjs";
import {
  coarseOf as evidenceCoarseOf, BUILTIN_FAMILY_TO_FINE, evidenceFamilyOf,
} from "./evidence-family.mjs";

// FS5 fix (2026-09-24 family-split review, MED, pre-existing): a HISTORICAL
// row's fine evidence-family key, for loadLocalHistory() below. Deliberately
// does NOT import bench/runner.mjs directly (this module stays import-light
// -- see the banner above); `taskFamilyOf` and `localMapping` are INJECTED
// by the caller instead (scripts/benchmark.mjs, which already imports both
// bench/runner.mjs and this module) -- the same dependency-injection style
// bench/evidence-family.mjs's own evidenceFamilyOf() already uses for
// `taskFamilyOf`.
//
// FS8 fix (2026-09-24 round-2 family-split review, CRITICAL): when
// `taskFamilyOf` IS injected, this delegates to evidenceFamilyOf() with the
// EXACT SAME precedence bench/runner.mjs's rebuildSummary() uses for every
// other classification call in this plugin -- row field > task.evidenceFamily
// (already baked into the row by the time it is on disk, by
// runOne()/harnessErrorRow()'s own stamping) > the local mapping file >
// the built-in taskFamilyOf(taskId) > unknown. Before this fix, a legacy row
// with no `evidence_family_fine` fell back to ONLY its own coarse
// `task_family` (skipping the local mapping and the built-in registry
// entirely) -- so a real architecture/mined row with `task_family: "other"`
// (an external harness that sets no family at all -- see FS2) was
// misclassified "unknown" even when a local mapping file existed that would
// have classified it correctly. See docs/BENCHMARK.md "Evidence families".
//
// When `taskFamilyOf` is NOT injected (a bare caller with no runner.mjs
// access at all -- e.g. a unit test fixture), this keeps the PRE-FS8
// fallback unchanged: row field, else the row's own already-recorded
// COARSE `task_family` mapped through the same registry. It never consults
// `localMapping` on this path -- matching a taskId against it needs a real
// taskId a caller with no taskFamilyOf has no other use for anyway.
export function fineFamilyOfHistoryRow(row, { taskFamilyOf = null, localMapping = null } = {}) {
  if (taskFamilyOf) {
    const { fine } = evidenceFamilyOf({
      taskId: row.task, row, taskFamilyOf, localMapping,
    });
    return fine;
  }
  if (typeof row.evidence_family_fine === "string" && row.evidence_family_fine) return row.evidence_family_fine;
  const coarse = row.task_family || "other";
  return BUILTIN_FAMILY_TO_FINE[coarse] || "unknown";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Seed + local history
// ---------------------------------------------------------------------------

let _seedCache = null;
export function loadSeed() {
  if (_seedCache) return _seedCache;
  const seedPath = path.join(__dirname, "config", "estimate-seed.json");
  _seedCache = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  return _seedCache;
}

function median(nums) {
  const a = nums.filter((n) => typeof n === "number" && !Number.isNaN(n)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Scans every results.jsonl this machine already has (default:
// dataDir()/benchmarks/*/results.jsonl -- the same root bench/runner.mjs's
// defaultResultsRoot() writes to) and aggregates medians per
// (task_family, requested_model, requested_effort), in the SAME shape as
// the shipped seed's `families` -- so mediansFor() below can treat "local
// history" and "seed" identically. budget_exhausted, auth_error and
// collision rows are excluded (they never reflect a genuine completed run's
// time/cost). is_rescore_retry rows are excluded too (round 2, 2026-09 delta
// review): bench/runner.mjs's rescoreOne() INHERITS its cost/token/duration
// fields verbatim from the original row it re-scores (no model call was
// made, so nothing about spend actually changed) -- counting both would
// double-count that one real run's cost/time. The ORIGINAL row (whether it
// needed a re-score or not) is never excluded here; its cost/tokens are
// genuine regardless of which way its pass/fail verdict ultimately landed
// in rebuildSummary(). A row's `cleanup_error` (bench/tasks/common.mjs's
// removeDirWithRetry() -- a sandbox/temp-dir removal that failed even after
// retrying) is likewise NEVER a reason to exclude a row here: the run's own
// cost/duration are unaffected by whether its leftover directory was
// cleaned up afterward, so this function reads only the named fields above
// and never checks for that key at all. Never throws: a machine with no
// history at all
// yields `{ families: {} }`, not an error -- this is expected on a fresh
// install.
export function loadLocalHistory({ resultsRoot, taskFamilyOf = null, localMapping = null } = {}) {
  const root = resultsRoot || path.join(dataDir(), "benchmarks");
  const families = {};
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
  } catch {
    return { families: {}, source: "local-history", root };
  }
  const byFamilyKey = new Map();
  for (const dir of dirs) {
    const jsonlPath = path.join(dir, "results.jsonl");
    let lines;
    try {
      lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.terminal_reason === "budget_exhausted" || row.auth_error || row.collision || row.is_rescore_retry) continue;
      // FS5 fix: this used to be `row.task_family || "other"` -- the COARSE
      // built-in family ("easy" | "hard" | "real" | "pack" | "other") --
      // while mediansFor()/estimateRun() below key every lookup by the FINE
      // evidence-family label ("real-bugfix", "architecture", ...). A coarse
      // key here NEVER matched a fine lookup key, so local REAL-WORLD
      // history was silently ignored in favor of the seed/rough-guess
      // fallback no matter how much of it existed on this machine. See
      // fineFamilyOfHistoryRow() above and docs/BENCHMARK.md "Evidence
      // families".
      const family = fineFamilyOfHistoryRow(row, { taskFamilyOf, localMapping });
      // FS8 fix (2026-09-24 round-2 family-split review, CRITICAL): "unknown"
      // is EXCLUDED from local history entirely -- never given its own
      // famKey, never contributing a median to any estimate, regardless of
      // which path above produced it. Before this fix, a legacy row this
      // classifier could not place (most often a real architecture/mined row
      // with no evidence_family_fine and no matching local mapping) fell
      // into "unknown" and had its real dollars/tokens POOLED there with
      // anything else that landed in the same misc bucket (a genuinely
      // unclassifiable synthetic id, for instance) -- see
      // docs/BENCHMARK.md "Evidence families". No caller of mediansFor()/
      // estimateRun() ever deliberately asks for family "unknown" data (an
      // "unknown"-family plan row always falls through to
      // roughGuessFallbackFor() instead -- see that function's own note), so
      // this exclusion changes nothing for a well-labelled row and closes
      // the pooling hole for a badly-labelled one.
      if (family === "unknown") continue;
      const model = row.requested_model || "unknown";
      const effort = row.requested_effort || "none";
      const famKey = family;
      const cellKey = model + "|" + effort;
      if (!byFamilyKey.has(famKey)) byFamilyKey.set(famKey, new Map());
      const cells = byFamilyKey.get(famKey);
      if (!cells.has(cellKey)) cells.set(cellKey, []);
      cells.get(cellKey).push(row);
    }
  }
  for (const [famKey, cellsMap] of byFamilyKey) {
    const cells = {};
    for (const [cellKey, rows] of cellsMap) {
      const [model, effort] = cellKey.split("|");
      cells[cellKey] = {
        model, effort, n: rows.length,
        medianDurationMs: median(rows.map((r) => r.duration_ms)),
        medianCostUsd: median(rows.map((r) => r.cost_usd)),
        medianInputTokens: median(rows.map((r) => r.input_tokens)),
        medianCacheReadTokens: median(rows.map((r) => r.cache_read_tokens)),
        medianCacheCreationTokens: median(rows.map((r) => r.cache_creation_tokens)),
        medianOutputTokens: median(rows.map((r) => r.output_tokens)),
        medianNumTurns: median(rows.map((r) => r.num_turns)),
      };
    }
    families[famKey] = { totalRows: null, keptRows: null, cells };
  }
  return { families, source: "local-history", root };
}

// Resolves the medians for one (family, model, effort), preferring LOCAL
// history over the shipped seed whenever local history has at least one run
// for that exact cell -- "estimates come from results already on this
// machine" per ADR 0003 sec 3's cost-controls note; the seed is only the
// fallback for a fresh install with no history yet.
export function mediansFor({ family, model, effort, seed = loadSeed(), history = null }) {
  const key = model + "|" + (effort || "none");
  const histFam = history && history.families && history.families[family];
  const histCell = histFam && histFam.cells && histFam.cells[key];
  if (histCell && histCell.n > 0) {
    return { medians: histCell, source: "local-history", n: histCell.n, label: `local history, n=${histCell.n}` };
  }
  const seedFam = seed.families && seed.families[family];
  const seedCell = seedFam && seedFam.cells && seedFam.cells[key];
  if (seedCell && seedCell.n > 0) {
    return { medians: seedCell, source: "seed", n: seedCell.n, label: `shipped seed, n=${seedCell.n}` };
  }
  // Labelled by evidence-family KIND (bench/evidence-family.mjs), never a
  // generic "no local history" -- operator direction 2026-09-24: real-world
  // and synthetic evidence are never pooled, including at the fallback
  // label. A REAL family with zero data must say so explicitly (never
  // implying its guess came from, or was validated against, synthetic
  // numbers) and vice versa. See ROUGH_GUESS_FALLBACKS below for the actual
  // numbers used alongside this label.
  const kind = evidenceCoarseOf(family);
  const label = kind === "real" ? "no local real-world history, rough guess"
    : kind === "synthetic" ? "no local synthetic history, rough guess"
    : "no local history, rough guess (evidence family unknown)";
  return { medians: null, source: "none", n: 0, label };
}

// Conservative rough-guess fallbacks used ONLY when neither local history
// nor the seed has ANY cell for the requested family at all (a brand new
// task family with zero data anywhere) -- clearly labelled, never silently
// treated as measured. ONE fallback per evidence-family KIND
// (bench/evidence-family.mjs), never a single shared number: a real-world
// family's guess must never be derived from synthetic numbers, and a
// synthetic family's guess must never borrow from real-world numbers --
// operator direction 2026-09-24, see docs/BENCHMARK.md "Evidence families".
//
// REAL is sized at the seed's own real-bugfix median (the middle of the
// real-world range this benchmark has actually measured). SYNTHETIC is
// sized at the seed's own hard-synthetic median (the middle of the
// synthetic range measured). UNKNOWN (a family this benchmark cannot
// classify as either -- see evidenceFamilyOf()) uses the same conservative
// numbers REAL does only because a wholly unclassified family is, in
// practice, more likely to be a new real-world source (a mined pack, a new
// architecture family) than a new synthetic one; it is never returned for a
// family evidenceCoarseOf() already knows is "synthetic".
const ROUGH_GUESS_FALLBACKS = {
  real: {
    medianDurationMs: 45000, medianCostUsd: 0.15,
    medianInputTokens: 10, medianCacheReadTokens: 150000, medianCacheCreationTokens: 12000,
    medianOutputTokens: 2500, medianNumTurns: 5,
  },
  synthetic: {
    medianDurationMs: 15000, medianCostUsd: 0.08,
    medianInputTokens: 7, medianCacheReadTokens: 110000, medianCacheCreationTokens: 9500,
    medianOutputTokens: 1200, medianNumTurns: 5,
  },
};
ROUGH_GUESS_FALLBACKS.unknown = ROUGH_GUESS_FALLBACKS.real;

// Exported for tests. Picks the right rough-guess fallback for a family by
// its evidence-family KIND, never by name -- so a future fine label (a new
// real pack kind, a new synthetic difficulty tier) is covered automatically
// as soon as it is registered in bench/evidence-family.mjs.
export function roughGuessFallbackFor(family) {
  const kind = evidenceCoarseOf(family);
  return ROUGH_GUESS_FALLBACKS[kind] || ROUGH_GUESS_FALLBACKS.unknown;
}

// ---------------------------------------------------------------------------
// Judge-vote cost (operator direction, 2026-09-24): the pre-run estimate
// previously accounted for ZERO judge cost at all -- a rubric judge casts
// bench/judge.mjs's JUDGE_VOTES (3) votes per judged answer, each a real
// model call with its own $ cost (bench/runner.mjs's runOne() stamps the
// TOTAL as `judge_cost_usd` alongside `judge_votes` on the judged row), and
// none of that ever showed up in formatEstimate()'s numbers. Measured on
// real architecture-pack judging: ~21 judged answers (63 votes) cost about
// $54 total, i.e. about $0.81/vote at fable/high -- roughly 3x what a
// synthetic-task guess would have suggested. See bench/config/estimate-seed.json's
// own `judgeVoteAnchor.note`.
// ---------------------------------------------------------------------------

// Scans the SAME local results.jsonl history loadLocalHistory() reads, for
// rows a rubric judge actually voted on -- `judge_cost_usd` and `judge_votes`
// are stamped together or not at all (bench/runner.mjs's runOne()), so
// either both are present and usable or neither is. `judge_cost_usd` is the
// TOTAL for that judged answer's `judge_votes` votes, so the per-VOTE cost is
// `judge_cost_usd / judge_votes`, medianed per (judge_model, judge_effort) --
// the same "median across rows, keyed by model|effort" shape loadLocalHistory()
// uses, just without the evidence-family dimension (judge cost is driven by
// the judge's own model/effort, not by which family the JUDGED task belongs
// to). Never throws: no local judge-vote history anywhere yields `{}`.
export function loadLocalJudgeVoteHistory({ resultsRoot } = {}) {
  const root = resultsRoot || path.join(dataDir(), "benchmarks");
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
  } catch {
    return {};
  }
  const byCell = new Map();
  for (const dir of dirs) {
    const jsonlPath = path.join(dir, "results.jsonl");
    let lines;
    try {
      lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof row.judge_cost_usd !== "number" || typeof row.judge_votes !== "number" || row.judge_votes <= 0) continue;
      const model = row.judge_model || "unknown";
      const effort = row.judge_effort || "none";
      const key = model + "|" + effort;
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push(row.judge_cost_usd / row.judge_votes);
    }
  }
  const out = {};
  for (const [key, perVoteCosts] of byCell) {
    out[key] = { medianCostUsdPerVote: median(perVoteCosts), n: perVoteCosts.length };
  }
  return out;
}

// Tier pricing relative to FABLE, the model bench/config/estimate-seed.json's
// `judgeVoteAnchor` was measured on -- a DIFFERENT anchor from
// bench/runner.mjs's own modelPriceRatioToSonnet() (that one scales a per-task
// BUDGET CAP relative to Sonnet; this one scales a judge-vote COST relative to
// Fable). Deliberately duplicated here rather than importing
// modelPriceRatioToSonnet() from bench/runner.mjs -- this module stays
// import-light (see the file banner above); the two ratios also anchor on
// different reference tiers, so a shared helper would need a parameter this
// file has no other use for. A dated id (`claude-fable-5-1`, `claude-opus-5-5`,
// ...) is checked against classifyReferenceModel() FIRST for its own exact
// historical pricing; an id with no reference entry falls back to its current
// alias tier. Returns 1 (no scaling) whenever either model's pricing is
// unreadable -- fail toward the seed's own already-measured number rather
// than guessing a ratio.
function fablePricing() {
  return modelTiers().tiers?.fable?.resolvesTo?.pricing || null;
}

function judgeModelPricing(fullModelId) {
  const ref = classifyReferenceModel(fullModelId);
  if (ref?.pricing) return ref.pricing;
  const alias = classifyModel(fullModelId).alias;
  return (modelTiers().tiers || {})[alias]?.resolvesTo?.pricing || null;
}

// Exported for tests.
export function judgePriceRatioToFable(fullModelId) {
  const fable = fablePricing();
  const model = judgeModelPricing(fullModelId);
  if (!fable || !model) return 1;
  if (typeof model.inputPerMTok !== "number" || typeof model.outputPerMTok !== "number"
    || typeof fable.inputPerMTok !== "number" || typeof fable.outputPerMTok !== "number"
    || fable.inputPerMTok <= 0 || fable.outputPerMTok <= 0) return 1;
  const inRatio = model.inputPerMTok / fable.inputPerMTok;
  const outRatio = model.outputPerMTok / fable.outputPerMTok;
  return (inRatio + outRatio) / 2;
}

// Resolves the $/vote for one (judge model, judge effort), preferring LOCAL
// history over the seed anchor -- same precedence mediansFor() gives writer
// cells. `history` is loadLocalJudgeVoteHistory()'s own flat `{ "<model>|<effort>":
// { medianCostUsdPerVote, n } }` shape (never the family-keyed shape
// loadLocalHistory() returns -- judge cost has no family dimension).
export function judgeVoteCostFor({ model, effort, seed = loadSeed(), history = null }) {
  const key = model + "|" + (effort || "none");
  const hist = history && history[key];
  if (hist && hist.n > 0) {
    return {
      costUsdPerVote: hist.medianCostUsdPerVote, source: "local-history", n: hist.n,
      label: `local history, n=${hist.n} votes`,
    };
  }
  const anchor = seed.judgeVoteAnchor;
  if (!anchor || typeof anchor.costUsdPerVote !== "number") {
    return { costUsdPerVote: null, source: "none", n: 0, label: "no judge-vote data anywhere -- judge cost omitted" };
  }
  const ratio = judgePriceRatioToFable(model);
  const costUsdPerVote = anchor.costUsdPerVote * ratio;
  const label = Math.abs(ratio - 1) < 1e-9
    ? anchor.note
    : `${anchor.note}, scaled ${ratio.toFixed(2)}x for this tier`;
  return {
    costUsdPerVote, source: "seed", n: anchor.n ?? null, label,
  };
}

// ---------------------------------------------------------------------------
// Weekly-point anchors -> points per run
// ---------------------------------------------------------------------------

function sonnetBaselineCost(familyMedians) {
  if (!familyMedians || !familyMedians.cells) return null;
  const preferred = familyMedians.cells["claude-sonnet-5|medium"];
  if (preferred && preferred.medianCostUsd) return preferred.medianCostUsd;
  const anySonnet = Object.values(familyMedians.cells).find((c) => /claude-sonnet/.test(c.model) && c.medianCostUsd);
  return anySonnet ? anySonnet.medianCostUsd : null;
}

// Points per run for one (family, model, effort), as a { low, high } range.
// `high` is the seed's own calibration anchor (already documented as an
// UPPER BOUND -- other sessions were running concurrently when it was
// measured), scaled by this cell's measured $ cost ratio to the family's own
// sonnet/medium baseline -- grounded in real dollars, not the unconfirmed
// Opus-vs-Sonnet plan-weight tooltip (which this function deliberately does
// NOT use; see `note` on the returned object). `low` is 60% of `high`, a
// documented assumption (the anchor's own upper-bound framing suggests the
// true attributable cost is lower, and 60% is a round, clearly-labelled
// guess, not a second measurement) -- see DECISIONS below for how to revise
// it. Returns null bounds when this family has no anchor at all.
// `anchorsKey` selects which anchor table in the seed to read -- the default
// "weeklyPointAnchors" (weekly usage window) or "fiveHourPointAnchors" (a
// SEPARATE, independently-measured 5-hour-window anchor -- see
// estimateRun()'s fiveHourPoints field below for why this is not merely the
// weekly figure re-labelled).
export function pointsPerRun({ family, model, effort, seed = loadSeed(), history = null, anchorsKey = "weeklyPointAnchors" }) {
  const anchors = seed[anchorsKey] || {};
  const alias = classifyModel(model).alias;
  let anchorKey = family;
  if (family === "hard-synthetic" && alias === "opus" && anchors["hard-synthetic-opus"]) anchorKey = "hard-synthetic-opus";
  const anchor = anchors[anchorKey];
  if (!anchor || !anchor.runs) {
    return {
      low: null, high: null, basis: "no-anchor",
      note: `no weekly-point calibration anchor for family "${family}" -- points cannot be estimated, only wall time/tokens/$.`,
    };
  }
  const baseRateHigh = anchor.points / anchor.runs;
  const { medians: familyMedians } = { medians: (history && history.families && history.families[family]) || (seed.families && seed.families[family]) };
  const baseline = sonnetBaselineCost(familyMedians);
  const { medians: cellMedians } = mediansFor({ family, model, effort, seed, history });
  const costRatio = (baseline && cellMedians && cellMedians.medianCostUsd) ? cellMedians.medianCostUsd / baseline : null;
  const effectiveRatio = costRatio == null ? 1 : costRatio;
  const high = baseRateHigh * effectiveRatio;
  const low = high * 0.6;
  const note = costRatio == null
    ? `no $ cost ratio available for ${model}/${effort || "none"} in "${family}" -- using the family's flat anchor rate unscaled.`
    : `scaled by this cell's measured $ cost ratio (${costRatio.toFixed(2)}x) to the family's sonnet/medium baseline.`;
  return {
    low, high, basis: anchorKey, costRatio,
    note: alias === "opus"
      ? `${note} The "Opus 5.5 = 1.5x Sonnet" plan-weight figure is UNCONFIRMED (an in-app tooltip) and is deliberately NOT used here -- this estimate uses the measured $ cost ratio instead.`
      : note,
  };
}

// ---------------------------------------------------------------------------
// The estimate itself
// ---------------------------------------------------------------------------

// Wall time under concurrency is not simply (sequential time / concurrency)
// -- parallel runs share CPU/memory/rate limits and slow each other down
// (see docs/BENCHMARK.md "Parallel runs"). 1.15 (15% overhead) is a
// documented, round DEFAULT ASSUMPTION, not a measurement -- there is no
// local history yet on how much concurrent runs actually slow each other by
// on this machine. Override via estimateRun()'s `overheadFactor`.
const DEFAULT_CONCURRENCY_OVERHEAD = 1.15;

// plan: array of { cellId, model, effort, family, n? }. `n` (default 1) lets
// a caller collapse identical rows (e.g. "12 reps of this cell x task") into
// one plan entry instead of 12 separate ones -- both are equivalent.
//
// judgeVotePlan (optional): { model, effort, votes, history? } -- the rubric
// judge's OWN model/effort (never a writer cell's) and the total number of
// VOTES it will cast across this whole plan (judged-answer count x
// bench/judge.mjs's JUDGE_VOTES; the caller computes this, since only it
// knows which cells are judge-eligible -- see scripts/benchmark.mjs). `null`
// (the default) omits judge cost entirely, unchanged from before this
// existed -- every existing caller with no judge configured is unaffected.
// `history` here is loadLocalJudgeVoteHistory()'s own flat shape, NOT the
// family-keyed `history` this function's other params already use.
export function estimateRun({
  plan, concurrency = 1, seed = loadSeed(), history = null, overheadFactor = DEFAULT_CONCURRENCY_OVERHEAD, judgeVotePlan = null,
}) {
  let totalRuns = 0;
  let sequentialWallMs = 0;
  const tokensByClass = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let apiCostUsd = 0;
  let pointsLow = 0;
  let pointsHigh = 0;
  // Separate accumulator for the 5-hour window -- see the fiveHourPoints
  // field below. anyFiveHourAnchor stays false (and the field reports
  // "unknown") unless bench/config/estimate-seed.json ships a REAL, measured
  // fiveHourPointAnchors entry for at least one planned row; it is never
  // synthesized from the weekly figure.
  let fiveHourPointsLow = 0;
  let fiveHourPointsHigh = 0;
  let anyFiveHourAnchor = false;
  const perCell = [];
  const familiesWithNoAnchor = new Set();
  let anyRoughGuess = false;

  for (const row of plan) {
    const n = row.n || 1;
    const { medians, source, label } = mediansFor({ family: row.family, model: row.model, effort: row.effort, seed, history });
    const m = medians || roughGuessFallbackFor(row.family);
    if (!medians) anyRoughGuess = true;
    const pts = pointsPerRun({ family: row.family, model: row.model, effort: row.effort, seed, history });
    if (pts.low == null) familiesWithNoAnchor.add(row.family);
    const fiveHourPts = pointsPerRun({
      family: row.family, model: row.model, effort: row.effort, seed, history, anchorsKey: "fiveHourPointAnchors",
    });
    if (fiveHourPts.low != null) {
      fiveHourPointsLow += fiveHourPts.low * n;
      fiveHourPointsHigh += fiveHourPts.high * n;
      anyFiveHourAnchor = true;
    }

    totalRuns += n;
    sequentialWallMs += (m.medianDurationMs || 0) * n;
    tokensByClass.input += (m.medianInputTokens || 0) * n;
    tokensByClass.cacheRead += (m.medianCacheReadTokens || 0) * n;
    tokensByClass.cacheWrite += (m.medianCacheCreationTokens || 0) * n;
    tokensByClass.output += (m.medianOutputTokens || 0) * n;
    apiCostUsd += (m.medianCostUsd || 0) * n;
    if (pts.low != null) { pointsLow += pts.low * n; pointsHigh += pts.high * n; }

    perCell.push({
      cellId: row.cellId || `${row.model}/${row.effort || "none"}`,
      model: row.model, effort: row.effort || null, family: row.family, n,
      wallTimeMsSequential: (m.medianDurationMs || 0) * n,
      costUsd: (m.medianCostUsd || 0) * n,
      tokens: {
        input: (m.medianInputTokens || 0) * n,
        cacheRead: (m.medianCacheReadTokens || 0) * n,
        cacheWrite: (m.medianCacheCreationTokens || 0) * n,
        output: (m.medianOutputTokens || 0) * n,
      },
      pointsLow: pts.low != null ? pts.low * n : null,
      pointsHigh: pts.high != null ? pts.high * n : null,
      source, label,
      isFable: classifyModel(row.model).alias === "fable",
    });
  }

  const wallTimeMsAtConcurrency = Math.max(1, concurrency) > 1
    ? Math.ceil((sequentialWallMs / Math.max(1, concurrency)) * overheadFactor)
    : sequentialWallMs;

  // Judge-vote cost: folded into apiCostUsd (it is a real $ cost of the run,
  // same as any writer cell's) AND reported separately (judgeVote below) so
  // a reader can see where it came from and how much of the total it is --
  // never silently invisible inside one lump sum.
  let judgeVote = null;
  if (judgeVotePlan && judgeVotePlan.votes > 0) {
    const jv = judgeVoteCostFor({
      model: judgeVotePlan.model, effort: judgeVotePlan.effort, seed, history: judgeVotePlan.history,
    });
    const totalCostUsd = (jv.costUsdPerVote || 0) * judgeVotePlan.votes;
    apiCostUsd += totalCostUsd;
    judgeVote = {
      votes: judgeVotePlan.votes, costUsdPerVote: jv.costUsdPerVote, totalCostUsd, source: jv.source, label: jv.label,
    };
  }

  return {
    totalRuns,
    concurrency: Math.max(1, concurrency),
    wallTimeMs: wallTimeMsAtConcurrency,
    wallTimeMsSequential: sequentialWallMs,
    tokensByClass,
    apiCostUsd,
    judgeVote,
    weeklyPoints: { low: round3(pointsLow), high: round3(pointsHigh) },
    // "unknown" (null bounds) unless bench/config/estimate-seed.json ships a
    // REAL, independently-measured fiveHourPointAnchors entry for at least
    // one planned row. An earlier version of this field copied the WEEKLY
    // points here unconditionally -- presented as a real number while
    // actually being an unmeasured guess dressed up as one (2026-09
    // adversarial review finding, Track B fix #4). No such anchor is shipped
    // today, so this is "unknown" for every plan until one is measured and
    // added to the seed.
    fiveHourPoints: anyFiveHourAnchor
      ? {
        low: round3(fiveHourPointsLow), high: round3(fiveHourPointsHigh),
        derivedFrom: "measured 5-hour anchor (bench/config/estimate-seed.json fiveHourPointAnchors)",
      }
      : {
        low: null, high: null,
        derivedFrom: "unknown -- no measured 5-hour anchor configured (see bench/config/estimate-seed.json)",
      },
    perCell,
    hasFableCell: perCell.some((c) => c.isFable),
    anyRoughGuess,
    familiesWithNoAnchor: [...familiesWithNoAnchor],
  };
}

function round3(n) {
  return n == null ? null : Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Confirmation gate
// ---------------------------------------------------------------------------

// Always requires confirmation when: the estimate is above `confirmAbovePoints`
// weekly points (default 2, configurable), any fable cell is included, or the
// projected weekly % would cross `weeklyCeilingPct` (when given). Uses the
// HIGH end of the range for every check -- the conservative side.
export function shouldConfirm(estimate, { confirmAbovePoints = 2, weeklyCeilingPct = null, currentWeeklyPct = null } = {}) {
  const reasons = [];
  if (estimate.weeklyPoints.high != null && estimate.weeklyPoints.high > confirmAbovePoints) {
    reasons.push(`estimate (${estimate.weeklyPoints.high} pts high end) exceeds the ${confirmAbovePoints}-point confirmation threshold`);
  }
  if (estimate.hasFableCell) {
    reasons.push("plan includes at least one Fable cell");
  }
  if (weeklyCeilingPct != null && currentWeeklyPct != null && estimate.weeklyPoints.high != null
    && (currentWeeklyPct + estimate.weeklyPoints.high) >= weeklyCeilingPct) {
    reasons.push(`projected weekly usage (${currentWeeklyPct}% + ${estimate.weeklyPoints.high} pts) would reach or cross the configured ceiling (${weeklyCeilingPct}%)`);
  }
  return { required: reasons.length > 0, reasons };
}

// Suggests a cheaper --cells list by dropping the most expensive cells
// (highest pointsHigh first), always dropping Fable cells first when
// `dropFable` is set. Returns the remaining cell ids (order preserved) and
// the ones it would drop -- printed by formatEstimate() as a ready-to-paste
// --cells value, never applied automatically.
export function suggestCheaperCellSet(estimate, { dropFable = true, maxCells = null } = {}) {
  const byCell = new Map();
  for (const c of estimate.perCell) {
    if (!byCell.has(c.cellId)) byCell.set(c.cellId, { cellId: c.cellId, points: 0, isFable: c.isFable });
    const e = byCell.get(c.cellId);
    e.points += c.pointsHigh || 0;
    e.isFable = e.isFable || c.isFable;
  }
  const cells = [...byCell.values()];
  const dropped = [];
  let kept = cells;
  if (dropFable) {
    kept = cells.filter((c) => !c.isFable);
    dropped.push(...cells.filter((c) => c.isFable).map((c) => c.cellId));
  }
  if (maxCells != null && kept.length > maxCells) {
    kept = [...kept].sort((a, b) => b.points - a.points);
    dropped.push(...kept.slice(0, kept.length - maxCells).map((c) => c.cellId));
    kept = kept.slice(kept.length - maxCells);
  }
  return { cells: kept.map((c) => c.cellId), dropped };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtMs(ms) {
  if (ms == null) return "n/a";
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 90) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(2)}h`;
}

function fmtRange(r, unit = "") {
  if (r.low == null || r.high == null) return "n/a";
  return r.low === r.high ? `${r.low}${unit}` : `${r.low}-${r.high}${unit}`;
}

// currentWeeklyPct: the skill reads this via get_usage and passes it in --
// this module (and scripts/benchmark.mjs, a plain Node script) cannot read
// plan usage itself. null/undefined prints "unknown", never a guess.
export function formatEstimate(estimate, { currentWeeklyPct = null, weeklyCeilingPct = null, confirmAbovePoints = 2 } = {}) {
  const lines = [];
  lines.push(`PRE-RUN ESTIMATE -- ${estimate.totalRuns} run(s) at --concurrency ${estimate.concurrency}`);
  lines.push(`  wall time:    ~${fmtMs(estimate.wallTimeMs)}` + (estimate.concurrency > 1 ? ` (sequential would be ~${fmtMs(estimate.wallTimeMsSequential)}; parallel runs slow each other down)` : ""));
  lines.push(`  tokens:       input ${Math.round(estimate.tokensByClass.input)}, cache-read ${Math.round(estimate.tokensByClass.cacheRead)}, `
    + `cache-write ${Math.round(estimate.tokensByClass.cacheWrite)}, output ${Math.round(estimate.tokensByClass.output)}`);
  lines.push(`  API-equivalent $: ~$${estimate.apiCostUsd.toFixed(2)}` + (estimate.judgeVote ? " (includes judge-vote cost below)" : ""));
  if (estimate.judgeVote) {
    const jv = estimate.judgeVote;
    const perVoteText = jv.costUsdPerVote == null ? "unknown" : `$${jv.costUsdPerVote.toFixed(3)}/vote`;
    lines.push(`  judge votes:  ${jv.votes} vote(s) x ${perVoteText} = ~$${jv.totalCostUsd.toFixed(2)}  [${jv.label}]`);
  }
  const fiveHourText = estimate.fiveHourPoints.low == null
    ? "unknown (no measured 5-hour anchor configured)"
    : `${fmtRange(estimate.fiveHourPoints, " pts")} (measured 5-hour anchor)`;
  lines.push(`  weekly-window points: ${fmtRange(estimate.weeklyPoints, " pts")}  |  5-hour-window points: ${fiveHourText}`);
  const cur = currentWeeklyPct == null ? "unknown" : `${currentWeeklyPct}%`;
  const projected = (currentWeeklyPct == null || estimate.weeklyPoints.high == null)
    ? "unknown"
    : `${(currentWeeklyPct + estimate.weeklyPoints.low).toFixed(1)}-${(currentWeeklyPct + estimate.weeklyPoints.high).toFixed(1)}%`;
  lines.push(`  current weekly usage: ${cur}  ->  projected after this run: ${projected}` + (weeklyCeilingPct != null ? ` (ceiling ${weeklyCeilingPct}%)` : ""));
  if (estimate.familiesWithNoAnchor.length) {
    lines.push(`  NOTE: no weekly-point calibration anchor for: ${estimate.familiesWithNoAnchor.join(", ")} -- points omitted for those cells' contribution.`);
  }
  if (estimate.anyRoughGuess) {
    lines.push("  NOTE: at least one cell has no local history AND no seed data -- its numbers are a rough guess (see per-cell breakdown).");
  }
  lines.push("");
  lines.push("  per-cell breakdown:");
  for (const c of estimate.perCell) {
    lines.push(`    ${c.cellId.padEnd(20)} family=${c.family.padEnd(16)} n=${String(c.n).padEnd(3)} `
      + `$${c.costUsd.toFixed(3)}  pts=${c.pointsLow != null ? `${round3(c.pointsLow)}-${round3(c.pointsHigh)}` : "n/a"}  [${c.label}]`);
  }
  const gate = shouldConfirm(estimate, { confirmAbovePoints, weeklyCeilingPct, currentWeeklyPct });
  if (gate.required) {
    lines.push("");
    lines.push("  CONFIRMATION REQUIRED before this run starts:");
    for (const r of gate.reasons) lines.push(`    - ${r}`);
    const cheaper = suggestCheaperCellSet(estimate, { dropFable: true });
    if (cheaper.dropped.length && cheaper.cells.length) {
      lines.push(`  To drop the most expensive cells (${cheaper.dropped.join(", ")}), rerun with --cells ${cheaper.cells.join(",")}`);
    } else if (cheaper.dropped.length) {
      lines.push(`  Dropping the most expensive cells (${cheaper.dropped.join(", ")}) would leave no cells at all -- narrow --tasks/--reps instead.`);
    }
  }
  lines.push("");
  lines.push("  Assumption: 1 weekly-window point is treated as 1 percentage point of the weekly usage window for the \"projected %\" line above -- unconfirmed, plan metering is not publicly documented.");
  return lines.join("\n");
}
