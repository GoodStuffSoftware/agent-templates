// Every line of plugin code, outside resolveRoute()'s own body, allowed to
// contain the token "override" (any case) — each one looked at and found NOT
// to read taskTypes.<type>.override: prose in comments, the operator
// override FILE, *_OVERRIDE environment variables, brevity/rules overrides,
// the trial's `overridesKindDelta` flag read from resolveRoute()'s stack
// metadata, and benchmark task text. See scan.mjs.
//
// Keyed by file and the line's normalised text (trimmed, whitespace
// collapsed), matched as a multiset — never by line number, so an unrelated
// edit elsewhere in a file never trips it. Adding, rewording or removing a
// listed line means editing its entry here, in the same change. If the new
// line READS a task type's trial, it does not belong here: go through
// resolveRoute() (its stack carries the trial entry and metadata).
export const ALLOWED = {
  "bench/estimate.mjs": [
    "// on this machine. Override via estimateRun()'s `overheadFactor`.",
  ],
  "bench/evidence-family.mjs": [
    "// family` override applied to any task with no declaration of its own",
    "// (bench/runner.mjs's `withEvidenceFamilyOverride()` -- an external",
  ],
  "bench/runner.mjs": [
    "// overrides). See docs/BENCHMARK.md \"Parallel runs\".",
    "// (see the fallback after the loop) -- see withEvidenceFamilyOverride().",
    "// override against the known-label registry BEFORE any cell/task loop runs",
    "export function checkEvidenceFamilyOverridePreflight(fine) {",
    "// FS2 fix: applies the run-wide evidence-family override to a task that",
    "export function withEvidenceFamilyOverride(task, override) {",
    "if (!override) return task;",
    "return { ...task, evidenceFamily: override };",
    "evidenceFamilyOverride = null,",
    // FS8 fix (2026-09-24 round-2 family-split review): runOne()/harnessErrorRow()
    // now also load and pass the local evidence-family mapping into this same
    // call -- the two lines below replace the pre-FS8 text (without
    // `, localMapping,`), one for each call site.
    "// declared evidenceFamily and no CLI/env override still gets the",
    "// brand-new row; task.evidenceFamily/override > local mapping > built-in",
    "taskId, task: withEvidenceFamilyOverride(task, evidenceFamilyOverride), taskFamilyOf, localMapping,",
    "taskId, task: withEvidenceFamilyOverride(task, evidenceFamilyOverride), taskFamilyOf, localMapping,",
    "cellId, cell, taskId, task, rep, error, cliVersion, evidenceFamilyOverride = null,",
    "// override would otherwise misclassify (pre-FS3) or abort mid-batch",
    "const evidenceFamilyOverride = checkEvidenceFamilyOverridePreflight(args.evidenceFamily);",
    "cellId, cell, taskId, task, rep, outDir, answersDir, isolateHome: args.isolateHome, evidenceFamilyOverride,",
    "JSON.stringify(harnessErrorRow({ cellId, cell, taskId, task, rep, error: e, evidenceFamilyOverride })) + \"\\n\",",
  ],
  "bench/tasks/common.mjs": [
    "// overrides either.",
  ],
  "bench/tasks/hard-instruction-logic.mjs": [
    "lines.push(\"11. Precedence: for records with CATEGORY = test AND owner exactly unassigned, do NOT add \" + bq(\"needs-owner\") + \" (this overrides rule 8) -- except see rule 12.\");",
    "lines.push(\"12. Precedence: rule 11's exemption is itself cancelled when the record is ACTIVE (as defined in rule 4). That is: a record with CATEGORY = test, owner exactly unassigned, AND ACTIVE = true DOES get the \" + bq(\"needs-owner\") + \" flag after all (this overrides rule 11, which overrides rule 8).\");",
    "lines.push(\"14. If a record is hot (rule 13), add the flag \" + bq(\"hot\") + \" to it -- except a record with CATEGORY = doc NEVER gets the \" + bq(\"hot\") + \" flag, no matter how high its SCORE is (this overrides rule 13 for doc records).\");",
  ],
  "bench/tasks/instruction-logic.mjs": [
    "lines.push(\"7. Precedence: for records with CATEGORY = test, the \" + bq(\"large\") + \" flag from rules 4 and 5 never applies, even if the record has more than 200 lines. Rule 7 overrides rules 4 and 5 for test-category records.\");",
  ],
  "bench/tasks/real-opt-fallback.mjs": [
    "// AGENT_COMPANION_HOME_OVERRIDE sandboxing, never touches the real machine's",
  ],
  "hooks/lib/brevity.mjs": [
    "// directions, before the global override, before the plugin option default.",
    "// hand-edited config with a mistake in it degrades to \"no override\" for that",
  ],
  "hooks/lib/context.mjs": [
    "// The override merges BY ALIAS, so adding one model does not require",
    "// The operator override lives under the durable state root (stateRoot()) so",
    "// location under dataDir() is still honoured as a fallback so an override",
    "try { over = JSON.parse(readFileSync(join(dataDir(), 'model-tiers.json'), 'utf8')); } catch { /* no override: expected */ }",
    "} catch { /* bad regex in an override: skip it, fail open */ }",
    "// NOTHING ELSE reads `taskTypes.<type>.override` (tests/route-readers.test.mjs",
    "// 2. trial — the shipped ROUTING TRIAL (`taskTypes.<type>.override`).",
    "// trial override returned before effortFor() ran, so no consequence floor",
    "`${p.overridesKindDelta ? ', overrides the kind delta' : ''}${ev}`;",
    "// a test can set the override env vars per-test and get an isolated tree.",
    "return process.env.AGENT_COMPANION_HOME_OVERRIDE || homedir();",
    "// transcript-harvest/, the legacy model-tiers.json override location). Durable",
    "// shipped TRIAL override* may waive it with waivesFloor: \"elevated\",",
    "// honoured ONLY when the row's/override's source is operator-observed",
    "// integration's trial override carries this waiver (opus/medium,",
  ],
  "hooks/lib/memory-index.mjs": [
    "// itself honours AGENT_COMPANION_HOME_OVERRIDE/CLAUDE_CONFIG_DIR — this used",
    "// memory files even with the override set.",
    "// silently override the 2000-char default, hitting 0 on the very first",
  ],
  "hooks/lib/rules.mjs": [
    "// the operator's file overrides or disables any of them by id, or adds their",
    "// accepts as a valid override. New (non-builtin) rules are written in full.",
    "// main thread: file `global` override, then the plugin's `brevity` option.",
  ],
  "hooks/lib/state-sync.mjs": [
    "// model-tiers.json (operator override): most-recently-modified source, and",
  ],
  "hooks/self-update.mjs": [
    "return process.env.AGENT_COMPANION_HOME_OVERRIDE || homedir();",
    "return process.env.AGENT_COMPANION_INSTALLED_PLUGINS_OVERRIDE",
    "// Same AGENT_COMPANION_HOME_OVERRIDE covers these two — a test fixture is one",
  ],
  "hooks/spawn-guard.mjs": [
    "// Model resolution order is: env override -> spawn parameter -> the agent's",
    "// and its routing-trial override entirely, fell back to the plain grid,",
    "// explicit TYPE (with its trial override) > a real WEIGHT: line >",
    "// the only place a benchmark-backed ROUTING TRIAL override attaches.",
    "// type's own weight/kind/consequence preset AND its override, same as",
    "// a deliberate deviation and bypasses the override when its value DEPARTS",
    "// were wanted. Global switch, per-agent override in either direction,",
    "// against it directly instead of recomputing an override-blind",
    "fit_trial: route?.trial ? true : false, // true when the fit judgement used a ROUTING TRIAL override, not the plain grid",
  ],
  // FS9 fix (2026-09-24 round-2 family-split review, HIGH): scripts/benchmark.mjs
  // (the gated entry point) gained its own --evidence-family flag/env
  // override, threaded through buildEstimatePlan()/runGlobalPool() the same
  // way bench/runner.mjs's own direct CLI already does -- none of this reads
  // taskTypes.<type>.override; it is bench/evidence-family.mjs's own,
  // unrelated real/synthetic classification override.
  "scripts/benchmark.mjs": [
    "checkEvidenceFamilyOverridePreflight, withEvidenceFamilyOverride, loadLocalEvidenceFamilyMapping,",
    "// FS9 fix (2026-09-24 round-2 family-split review, HIGH): `evidenceFamilyOverride`",
    "// task with no evidenceFamily of its own -- see withEvidenceFamilyOverride())",
    "cellIds, taskIds, tasksMap, reps, evidenceFamilyOverride = null, localMapping = null,",
    "taskId, task: withEvidenceFamilyOverride(task, evidenceFamilyOverride), taskFamilyOf, localMapping,",
    "cellId, cell, taskId: run.taskId, task, rep: run.rep, error: e, evidenceFamilyOverride: args.evidenceFamily,",
    "// FS9 fix: threads --evidence-family/the env override into the",
    "evidenceFamilyOverride: args.evidenceFamily,",
    "cellId, cell, taskId: run.taskId, task, rep: run.rep, error: e, evidenceFamilyOverride: args.evidenceFamily,",
    "let evidenceFamilyOverride;",
    "evidenceFamilyOverride = checkEvidenceFamilyOverridePreflight(args.evidenceFamily);",
    "cellIds: cellsToRun, taskIds, tasksMap, reps: args.reps, evidenceFamilyOverride, localMapping,",
    "cellIds: cellsToRun, taskIds, tasksMap, reps: args.reps, evidenceFamilyOverride, localMapping,",
  ],
  "scripts/brevity.mjs": [
    "// decided (per-agent beats the runtime global override, which beats the",
    "// node brevity.mjs default clear the runtime global override",
    "// node brevity.mjs clear --agent <type> drop that agent's override",
    "`brevity: runtime global override cleared; falling back to the plugin option ` +",
    "? `brevity: cleared the override for \"${agentType}\".`",
    ": `brevity: \"${agentType}\" had no override to clear.`,",
    "globalOverride: cfg.global,",
    "console.log(`runtime global override: ${out.globalOverride ?? '(not set)'}`);",
    "console.log('per-agent overrides:');",
    "console.log('per-agent overrides: (none)');",
    "if (agent) fail('\"default\" applies only to the global toggle; use \"clear --agent <type>\" to drop a per-agent override');",
  ],
  "scripts/capacity.mjs": [
    "// Full report: real machine stats + options/CLI overrides. This is what the",
  ],
  "scripts/checks.mjs": [
    "// AGENT_COMPANION_HOME_OVERRIDE (via claudeDir()) rather than raw homedir(),",
    "// ~/.claude/projects tree despite the override being set.",
    "// Same env-isolation convention as guardCanary: no override is set here, so",
  ],
  "scripts/detect.mjs": [
    "// location) IF it exists; the option overrides the path. Never required —",
    "// backing taskTypes.*.override actually covers it.\" Same freshness pattern",
    "// A taskType's `override` (config/model-tiers.json's routing trial: a",
    "// date. Past that date the override is still live and still routing spawns —",
    "// taskTypes.<type>.override — so a trial that stops winning (skipped by a",
    "// AGENT_COMPANION_HOME_OVERRIDE entirely, so a test (or this script's own",
    "// even with the override set. claudeDir() honours the override like every",
    "// actually worked in. AGENT_COMPANION_DISCOVERY_CLAUDE_JSON overrides the",
    "// through homeRoot(); AGENT_COMPANION_DISCOVERY_DEV_ROOT overrides them",
    "const devRootOverride = process.env.AGENT_COMPANION_DISCOVERY_DEV_ROOT;",
    "const devRoots = devRootOverride",
    "? devRootOverride.split(/[,;]/).map((s) => s.trim()).filter(Boolean)",
  ],
  "scripts/install-global-hooks.mjs": [
    "// --settings/--hooks-dir stay the primary override for real installer use;",
    "// claudeDir() (AGENT_COMPANION_HOME_OVERRIDE / CLAUDE_CONFIG_DIR-aware) is",
  ],
  "scripts/leak-sweep-canary.mjs": [
    "// override, so the canary's LEAK_CHECK_DEV_ROOT (set via sweepOpts.env)",
  ],
  "scripts/lib/cache-ttl.mjs": [
    "// --- Transcripts root, mirroring lib/coverage.mjs's own override convention -",
    "export function transcriptsRoot(override) {",
    "return override || process.env.AGENT_COMPANION_TRANSCRIPTS_ROOT || join(claudeDir(), 'projects');",
    "// override — one changed price does not require restating the table.",
    "try { over = JSON.parse(readFileSync(join(stateRoot(), 'model-pricing.json'), 'utf8')); } catch { /* no override: expected */ }",
    "// at module scope and a test that writes an override needs the next call to",
    "// a premium-tier-only pocket of savings that a per-agent override",
    "+ `clears ${MIN_REQUESTS_FOR_AGENT_ROW} requests with a negative delta to warrant a per-agent override`;",
  ],
  "scripts/lib/leak-scan-core.mjs": [
    "// Checked FIRST and OVERRIDES the generic placeholder set — a real handle",
  ],
  "scripts/lib/model-mismatch.mjs": [
    "} catch { /* bad regex in an override: skip */ }",
  ],
  "scripts/lib/publication-sweep.mjs": [
    "// listed so a caller can see them here, but sweepRepo() overrides both with",
  ],
  // 0.29.1 integration: the vault-guard track (branched before this scan
  // existed) added the shared git-env helper, whose `overrides` argument is
  // caller-supplied env vars, and vault comments about env overriding config.
  "scripts/lib/git-env.mjs": [
    "// case), then `overrides` laid on top. Overrides are the caller's explicit",
    "// merged `{ ...process.env, X }` passed as `overrides` must not smuggle the",
    "export function cleanGitEnv(env = process.env, overrides = {}) {",
    "for (const [k, v] of Object.entries(overrides || {})) {",
    "export function isolatedGitEnv(env = process.env, overrides = {}) {",
    "const out = cleanGitEnv(env, overrides);",
    "// GIT_AUTHOR_{NAME,EMAIL,DATE} / GIT_COMMITTER_{NAME,EMAIL,DATE} override the",
  ],
  "scripts/memory-vault.mjs": [
    "// env var remains a per-invocation override.",
    "// dates (vaultEnv()), which would otherwise override the vault's own",
    "// override as every other vault call. It is absolute here because init runs",
  ],
  "scripts/recommend.mjs": [
    "// Explicit flags override the preset; the preset fills what is not given.",
    "console.log(`\\nROUTING TRIAL — this type's output is a benchmark override, not the plain grid:`);",
    "if (out.trial.overridesKindDelta) console.log(` explicitly overrides the kind's effort delta (see rationale above)`);",
  ],
  "scripts/routing-table.mjs": [
    "// prevent. This reads config/model-tiers.json (plus any per-machine override)",
    "// — the only reader of taskTypes.<type>.override (tests/route-readers.test.mjs).",
    "L.push(`Each named task type is a preset over (weight, kind, consequence) and resolves through the same grid. \\`parity\\` weight = sized to the writer being reviewed (see Reviewer parity); \\`inherit\\` consequence = take the change's consequence. **\\`--type\\` is the preferred input over raw \\`--weight\\`/\\`--kind\\`** — a named type is the only place a measured routing-trial override (below) attaches; resolving by weight/kind alone always uses the plain grid.`);",
    "resolved = `\\`${tr.label}\\` _(trial override)_`;",
    "L.push(`### Routing trial (benchmark overrides, not the plain grid)`);",
    "L.push(`These task types resolve to a benchmark-backed (model, effort) pair that supersedes their own weight/kind/consequence grid resolution for the trial window below. The override applies only when the type is used as-is — passing an explicit \\`--weight\\`/\\`--kind\\`/\\`--consequence\\` that departs from the type's preset falls back to the plain grid (one equal to the preset restates the type and keeps the trial). Every OTHER task type in the list above is **UNBENCHMARKED** by this trial and keeps its grid-resolved routing unchanged.`);",
    "const trialLabel = `${ov.model}${ov.effort ? '/' + ov.effort : ''}` + (ov.overridesKindDelta ? ' _(overrides kind delta)_' : '');",
    "// reading taskTypes[].override directly, so a profile or a future layer",
    "// Overridable only for tests — same pattern as AGENT_COMPANION_HOME_OVERRIDE",
    "return process.env.AGENT_COMPANION_AGENTS_DIR_OVERRIDE",
  ],
  "scripts/rules.mjs": [
    "if (findRule(rules, id)) usageError(`id \"${id}\" already exists — use enable/disable, or edit ${rulesPath()} directly to override a built-in`);",
  ],
  "scripts/transcript-harvest.mjs": [
    "// AGENT_COMPANION_MEMORY_ROOT override, for the same reason: tests need a",
  ],
  "shims/global-hooks/agent-companion-staleness.mjs": [
    "// Same override convention as hooks/self-update.mjs, so a test fixture can",
    "return process.env.AGENT_COMPANION_HOME_OVERRIDE || homedir();",
    "return process.env.AGENT_COMPANION_INSTALLED_PLUGINS_OVERRIDE",
  ],
};
