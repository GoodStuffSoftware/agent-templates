// Project tiers, all the wording in one place: the three tiers and their cells, the change-risk
// floors, the batch rule, the session line, and the clauses spawned writers and reviewers get.
// lib/tier-clause.mjs picks the clause for a spawn; hooks/project-tier.mjs prints the session line;
// scripts/project-tiers.mjs prints the meanings and computes the floor. Pure functions, no I/O.
//
// A tier decides what a change of each RISK (low, mid, high) needs before it lands:
//   push  "Push on your word": unit tests and push; only a high-risk change gets a reviewer.
//   risk  "Risk-tiered": low lands after unit tests; mid gets one reviewer who reads; high also
//         gets the changed behaviour checked in the running app. The default.
//   gates "Full gates": as risk, plus one e2e pass per batch and the project's release gates.
// `reviewEveryChange: true` in the user's file turns every "no reviewer" cell into "one reviewer
// by reading", which keeps the review-every-change behaviour available.
// Field names in any output use project_tier: "tier" already means a model tier here.

import { fileURLToPath } from 'node:url';

export const RISKS = ['low', 'mid', 'high'];
const DEFAULT_ID = 'risk';

// The plugin root, as an agent can run it (CLAUDE_PLUGIN_ROOT, else this file's own location),
// the same resolution the pr-wait session-start hint uses.
const PLUGIN_ROOT = (process.env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL('../..', import.meta.url))).replace(/\\/g, '/').replace(/\/+$/, '');
export const FLOOR_COMMAND = `node "${PLUGIN_ROOT}/scripts/project-tiers.mjs" floor <base>..<head>`;

// What a reviewer may do for a high-risk change under risk and gates.
const HIGH_CHECK = 'after reading, check the touched behaviour for real with the project\'s own run or dev command (the compile that command does itself is fine); no separate full build, packaging or install, and if the check needs one report "not checked for real" and why';

// Each cell: writer (what the writer does), writerEvery (the same when reviewEveryChange is on; only
// cells that say "no reviewer"), line (the session-line form), lineEvery, reviewer (what a spawned
// reviewer does for this risk).
export const TIERS = {
  push: {
    id: 'push',
    label: 'Push on your word',
    meaning: 'low and mid: unit tests, then push, no reviewer. High: one reviewer reads, then push.',
    cells: {
      low: { writer: 'unit tests, then push, no reviewer', writerEvery: 'unit tests, one reviewer by reading, then push', line: 'unit tests, then push, no reviewer', lineEvery: 'one reviewer reads, then push', reviewer: 'read only' },
      mid: { writer: 'unit tests, then push, no reviewer', writerEvery: 'unit tests, one reviewer by reading, then push', line: 'unit tests, then push, no reviewer', lineEvery: 'one reviewer reads, then push', reviewer: 'read only' },
      high: { writer: 'one reviewer by reading, then push', line: 'one reviewer reads, then push', reviewer: 'read only' },
    },
  },
  risk: {
    id: 'risk',
    label: 'Risk-tiered',
    meaning: 'low: unit tests, land. Mid: one reviewer reads. High: one reviewer reads, then checks the changed behaviour in the running app.',
    cells: {
      low: { writer: 'unit tests, land, no reviewer', writerEvery: 'unit tests, one reviewer by reading, then land', line: 'unit tests, land, no reviewer', lineEvery: 'one reviewer reads, then land', reviewer: 'read only' },
      mid: { writer: 'one reviewer by reading', line: 'one reviewer reads', reviewer: 'read only' },
      high: { writer: 'one reviewer reads, then checks the changed behaviour in the running app', line: 'one reviewer reads, then checks the changed behaviour in the running app', reviewer: HIGH_CHECK },
    },
  },
  gates: {
    id: 'gates',
    label: 'Full gates',
    meaning: 'low: unit tests, lands with the next batch. Mid: one reviewer reads, and one e2e pass for the batch. High: the reviewer also checks the behaviour for real, plus the project\'s release gates.',
    cells: {
      low: { writer: 'unit tests, no reviewer, lands with the next batch', writerEvery: 'unit tests, one reviewer by reading, lands with the next batch', line: 'unit tests, no reviewer, lands with the next batch', lineEvery: 'one reviewer reads, lands with the next batch', reviewer: 'read only' },
      mid: { writer: 'one reviewer by reading; e2e once for the batch', line: 'one reviewer reads + e2e once for the batch', reviewer: 'read only; read the batch e2e result in the hand-off' },
      high: { writer: 'one reviewer reads and checks the changed behaviour for real; e2e once for the batch; the project\'s release gates', line: 'one reviewer reads and checks for real + e2e once for the batch + the project\'s release gates', reviewer: `${HIGH_CHECK}; read the batch e2e result in the hand-off` },
    },
  },
};

// The cell text for a tier, risk and role ('writer' | 'reviewer'). Unknown tier -> risk.
export function cellText(tier, risk, role = 'writer', reviewEveryChange = false) {
  const t = TIERS[tier] || TIERS.risk;
  const c = t.cells[RISKS.includes(risk) ? risk : 'mid'];
  if (role === 'reviewer') return c.reviewer;
  return reviewEveryChange && c.writerEvery ? c.writerEvery : c.writer;
}
const lineCell = (t, risk, every) => (every && t.cells[risk].lineEvery) || t.cells[risk].line;

// Risk floors, objective. A writer may state a higher risk, never a lower one; a reviewer may raise it, never lower it.
// FLOOR_RULES drives `project-tiers.mjs floor`; RISK_FLOORS is the compact line the clauses carry.
export const FLOOR_RULES = {
  highFiles: 8,
  highLines: 300,
  midSourceFiles: 2,
  midSourceLines: 40,
};
export const RISK_FLOORS = `floors: high = ${FLOOR_RULES.highFiles}+ files, ${FLOOR_RULES.highLines}+ changed lines, or a CI/build/deploy/hook, data/schema or sign-in/payments path; mid = ${FLOOR_RULES.midSourceFiles}+ source files, ${FLOOR_RULES.midSourceLines}+ changed source lines or a new source file; else low. State higher if the area has broken before, never lower`;

// Path kinds that force high, tested on the lowercase path with forward slashes.
export const HIGH_PATH_KINDS = [
  { kind: 'CI/build/deploy/hook', re: /(^|\/)(\.github|\.githooks|\.gitlab-ci|\.circleci|hooks)(\/|\.|$)|(^|\/)(dockerfile|docker-compose|jenkinsfile|makefile)|(^|\/)scripts\/ci|(^|\/)(vite|webpack|rollup|esbuild|babel)[^/]*\.config\.|(^|\/)tsconfig[^/]*\.json$|\.gradle(\.kts)?$|(^|\/)gradle\.properties$|(^|[/._-])(deploy|release)/ },
  { kind: 'data/schema', re: /(^|\/)migrations?\/|schema|\.sql$|\.rules$/ },
  { kind: 'sign-in/payments', re: /(^|[/._-])(auth(?!or)|login|signin|oauth|session|token|payment|billing|stripe|checkout)/ },
];

// Files that count for nothing: lockfiles and generated output.
const EXCLUDED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|cargo\.lock|go\.sum|poetry\.lock|gemfile\.lock|composer\.lock)$|\.lock$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|node_modules|coverage|__snapshots__)\/|\.generated\.|\.snap$/;
const DOCS = /\.(md|mdx|txt|rst|adoc)$|(^|\/)docs?\/|(^|\/)(license|changelog|notice)[^/]*$/;
const STYLES = /\.(css|scss|sass|less|styl)$/;
const TESTS = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]*$|_test\.[a-z0-9]+$/;
const CONFIG = /\.(json|ya?ml|toml|ini|cfg|env|properties)$/;

export function pathClass(path) {
  const p = String(path).replace(/\\/g, '/').toLowerCase();
  if (EXCLUDED.test(p)) return 'excluded';
  if (DOCS.test(p)) return 'docs';
  if (TESTS.test(p)) return 'tests';
  if (STYLES.test(p)) return 'styles';
  if (CONFIG.test(p)) return 'config';
  return 'source';
}

// The minimum risk a diff allows. files: [{path, added, deleted, isNew, forceKind?}]; added/deleted are
// line counts (0 for a binary file). forceKind names a high path kind decided by the caller (a package.json
// whose scripts changed). Returns { floor, reasons: [string], files, lines, kinds: [string] }.
export function riskFloor(files) {
  const live = (Array.isArray(files) ? files : []).filter((f) => f && pathClass(f.path) !== 'excluded');
  const lines = (f) => (Number(f.added) || 0) + (Number(f.deleted) || 0);
  const total = live.reduce((n, f) => n + lines(f), 0);
  const source = live.filter((f) => pathClass(f.path) === 'source');
  const sourceLines = source.reduce((n, f) => n + lines(f), 0);
  const kinds = [];
  for (const f of live) {
    const cls = pathClass(f.path);
    const p = String(f.path).replace(/\\/g, '/').toLowerCase();
    let kind = f.forceKind || null;
    if (!kind && cls !== 'docs' && cls !== 'tests' && cls !== 'styles') kind = HIGH_PATH_KINDS.find((k) => k.re.test(p))?.kind || null;
    if (kind) kinds.push(`${kind}: ${f.path}`);
  }
  const high = [];
  if (live.length >= FLOOR_RULES.highFiles) high.push(`${live.length} files changed (high at ${FLOOR_RULES.highFiles}+)`);
  if (total >= FLOOR_RULES.highLines) high.push(`${total} changed lines (high at ${FLOOR_RULES.highLines}+)`);
  if (kinds.length) high.push(`high-risk path kinds: ${kinds.slice(0, 6).join('; ')}${kinds.length > 6 ? `; +${kinds.length - 6} more` : ''}`);
  const stats = `${live.length} file(s), ${total} changed line(s), ${source.length} source file(s) with ${sourceLines} changed source line(s)`;
  if (high.length) return { floor: 'high', reasons: [...high, stats], files: live.length, lines: total, kinds };
  const mid = [];
  if (source.length >= FLOOR_RULES.midSourceFiles) mid.push(`${source.length} source files (mid at ${FLOOR_RULES.midSourceFiles}+)`);
  if (sourceLines >= FLOOR_RULES.midSourceLines) mid.push(`${sourceLines} changed source lines (mid at ${FLOOR_RULES.midSourceLines}+)`);
  if (source.some((f) => f.isNew)) mid.push('a new source file');
  if (mid.length) return { floor: 'mid', reasons: [...mid, stats], files: live.length, lines: total, kinds };
  return { floor: 'low', reasons: [live.length ? 'only docs, styles, config, tests or one small source file' : 'no changes', stats], files: live.length, lines: total, kinds };
}

// The batch rule: how a writer treats the expensive e2e run. Self-review.mjs (leg B) imports it for step 0.
export const BATCH_RULE = 'Finish every task in your brief first, with no self-chosen sections or milestone stops (chunking is the operator\'s call). Unit tests are cheap: run them while you work. E2E is the expensive run: hold it while other changes to the same repo are in flight and run it once for the whole batch, once per tree (note the tree id, git rev-parse HEAD^{tree}, with the result); a full e2e pass anywhere (local, push gate or CI) counts everywhere, and an unchanged tree is never rerun.';

const RISK_REPORT = 'RISK: low|mid|high with the reason';

// The one session line for the lead. `project` null means outside a repo.
export function tierLine(tier, project, opts = {}) {
  const every = !!opts.reviewEveryChange;
  if (!project) {
    const t = TIERS[tier] || TIERS[DEFAULT_ID];
    return `[agent-companion] No project (outside a repo): project_tier ${t.id} by default. Writers state RISK low|mid|high; low: ${lineCell(t, 'low', every)}; mid: ${lineCell(t, 'mid', every)}; high: ${lineCell(t, 'high', every)}. E2E once per batch and tree, never per change.`;
  }
  const t = TIERS[tier] || TIERS[DEFAULT_ID];
  return `[agent-companion] Project ${project}, project_tier ${t.id} (${t.label}): low = ${lineCell(t, 'low', every)}; mid = ${lineCell(t, 'mid', every)}; high = ${lineCell(t, 'high', every)}. Writers state RISK low|mid|high when done. E2E once per batch and tree, never per change.`;
}
const head = (tier, project) => {
  const t = TIERS[tier] || TIERS[DEFAULT_ID];
  return `Project ${project || '(none: outside a repo)'}, project_tier ${t.id} (${t.label}).`;
};
const floorSentence = `${RISK_FLOORS}. Floor for a range: ${FLOOR_COMMAND}`;

// kind: 'protocol' (a writer that runs the self-review protocol: picks its cell and spawns the reviewer),
// 'leg' (REVIEW: lead: one leg of a larger job, the lead applies the table once to the whole diff),
// 'plain' (a writer with no protocol: it reviews nothing, the lead applies the table).
export function writerClause(tier, project, opts = {}) {
  const every = !!opts.reviewEveryChange;
  const kind = opts.kind || 'protocol';
  const h = head(tier, project);
  if (kind === 'leg') {
    return `${h} You are one leg of a larger job: the lead applies the change-risk table once to the whole diff, so you review nothing and spawn no reviewer. Finish every task in the brief, with no self-chosen sections or milestone stops. Unit tests are cheap: run them while you work. Run no end-to-end tests, CI or full build: the lead runs one pass after all legs. You may write or extend e2e tests. Commit, push, then report. State ${RISK_REPORT} in your report (${floorSentence}).`;
  }
  if (kind === 'plain') {
    return `${h} The lead applies the change-risk table to the whole diff; you spawn no reviewer. State ${RISK_REPORT} in your report (${floorSentence}). ${BATCH_RULE}`;
  }
  const cell = (r) => cellText(tier, r, 'writer', every);
  return `${h} When done, state ${RISK_REPORT} and REVIEW: <the cell you applied> in your report. ${floorSentence}. Low: ${cell('low')}. Mid: ${cell('mid')}. High: ${cell('high')}. If your cell names a reviewer, spawn exactly one and mark its brief RISK: <your risk>; if it names none, skip the review step.`;
}

// For a reviewer: the cell by the writer's RISK (the brief's RISK: line), which it may raise, never lower.
export function reviewerClause(tier, project, opts = {}) {
  const h = head(tier, project);
  const cell = (r) => cellText(tier, r, 'reviewer');
  return `${h} Your checks depend on the RISK the writer states in your brief; you may raise it, never lower it, and with no RISK line judge it from the diff with these floors and say which you used. ${floorSentence}. Low: ${cell('low')}. Mid: ${cell('mid')}. High: ${cell('high')}.`;
}
