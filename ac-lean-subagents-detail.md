# ac-lean-subagents: handoff detail

Status: every item is implemented and committed on `feat/ac-lean-subagents` (10 commits on top of the current origin/main, version 0.31.0). NOT pushed to `feat/ac-lean-subagents`, no PR yet: the pre-push gate blocks it (see "Blocker"). This file is on `wip/ac-lean-subagents-2`.

## Blocker (verbatim)

`git push -u origin feat/ac-lean-subagents` runs `.githooks/pre-push` from `core.hooksPath = <primary checkout>\.githooks` (the PRIMARY checkout). Tests pass (scripts-tests 165 pass; agent-companion-tests 1947 pass, 0 fail, 2 todo, 1 skipped), but the leak-check step fails twice in a row:

```
leak-check: FAILED — 56 hit(s):
  grep.exe.stackdump:3  [git-sha-like]  <hex addresses from an msys-2.0.dll stack frame>
  ... (56 hits, all in that one file)
ci-local pre-push: BLOCKED — fix the failing suite(s) above before pushing.
Never use --no-verify; see CONTRIBUTING.md.
```

Cause: an untracked msys crash dump, `<primary checkout>\grep.exe.stackdump` (1,729 bytes, 2026-10-06 11:36), in the primary checkout root. It is not in this worktree and not from this work (the same file also sits in two other worktrees). `node scripts/ci-local.mjs --suite leak-check` run from this worktree passes. Fix: whoever owns the primary checkout deletes that stackdump (and the two other copies under `.claude/worktrees/` if they matter), then `git push -u origin feat/ac-lean-subagents` from `<this worktree>`. It takes about 25 minutes (full suite). I did not delete it (another session's tree) and did not bypass the hook.

One test failure seen on the first full run (delegation-guard) was flaky and passed on its own; earlier full runs had flakes in memory-vault-byte-exact, pr-wait and the git-brief tree-kill tests under load, all green when run alone. The real failure found by the first full run (premium-window-lock: the spawn guard must not load the lock helper) is fixed in the last commit listed below.

## What landed (oldest first; `git log --oneline origin/main..wip/ac-lean-subagents-2` prints the SHAs, which this file omits because leak-check flags short hashes)

1. audit: memory-index check follows `index_*.md` sub-indexes one level; `--fix` does not re-link them.
2. docs: citations point at the split team-orchestration references.
3. test: import order fix for the sub-index audit test.
4. S1/S2 (feat: lean ladder workers): generated `disallowedTools` per rung, `ac-browser` / `ac-browser-opus` variants, guards, recommend `--browser`; short descriptions and one-sentence bodies (S5 part).
5. fix: reporting contract names `<task>-detail.md` (native refusal of subagent report/summary/findings/analysis .md writes), lessons, inbox entry, test.
6. S5: contract delivered once (spawn-guard to SubagentStart handoff).
7. S4b: memory-budget, self-update, ladder-check, git-brief session-start skip a compacting subagent.
8. feat: shorter effort-check rule, scout kinds deduped, seven zero-use skill descriptions shortened.
9. chore: release 0.31.0 (version bump in plugin.json and marketplace.json, CHANGELOG, README, `docs/lean-verification/` kit).
10. fix: handoff uses one file per record, no lock (the spawn guard must not load the lock helper).

The pre-rebase copy of 1 to 9 is still on `wip/ac-lean-subagents`.

S3 (omitClaudeMd) is deliberately NOT done: evidence and decision are in the PR body below and in the operator's decision log (2026-10-06 entry).

## S5 root cause (keep)

The SubagentStart payload carries no prompt, so `p.agent_prompt` in `hooks/subagent-brevity.mjs` is never present, the marker check never matches, and the hook re-injects the contract whenever spawn-guard already appended it (about 71% of spawns). Fixed by `noteContractAppended` / `consumeContractAppended` in `hooks/lib/brevity.mjs` (one file per spawn under `state/contract-pending/`, per session, 3-minute expiry), a repeat-agent_id marker, and the fall-through reinforce when no record exists.

## Remaining

1. Clear the blocker above, push `feat/ac-lean-subagents`, open the PR with the body below (title: `feat(agent-companion): lean subagents (0.31.0)`), wait for CI green with `node "<plugin>/scripts/pr-wait.mjs" <pr>` (run in background). Do NOT merge: a parity reviewer goes first.
2. Operator: run `plugins/agent-companion/docs/lean-verification/README.txt` in a fresh session to prove (or not) that `disallowedTools: mcp__<server>` also drops deferred names and the instruction block; trim the per-server list to what pays if only schemas go.
3. After a push to main-bound branch the pre-push gate runs the whole suite; expect about 25 minutes.

## Test commands

- Whole gate: `node scripts/ci-local.mjs` (repo root; background it, read the output file).
- Leak check: `node scripts/leak-check.mjs`.
- Descriptions and tools drift: `node plugins/agent-companion/scripts/routing-table.mjs --check-agent-descriptions` (regenerate with `--sync-agent-descriptions`).
- Targeted suites (from `plugins/agent-companion`): `node --test tests/brevity.test.mjs tests/ladder-browser.test.mjs tests/agent-description-drift.test.mjs tests/session-start-subagent.test.mjs tests/scout-surface-dedupe.test.mjs tests/skill-descriptions.test.mjs tests/lead-effort-check.test.mjs tests/premium-window-lock.test.mjs tests/audit-memory-subindex.test.mjs tests/delegation-guard.test.mjs tests/ladder-check.test.mjs tests/gate-messages.test.mjs`.

---

# PR body (ready to paste)

## agent-companion 0.31.0: lean subagents

Source: the 2026-10-06 context-baseline report, section 4 (S1 to S5), plus the follow-ups from the operator. Do not merge before the parity review and the fresh-session verification below.

Cost, in the report's units (about 1,900 plan units a week): S1 + S2 + S5 are estimated at about 240 units a week, roughly 12% of the weekly limit, and the estimate is **unmeasured** until the fresh-session check below says what the harness really drops. S3 (about 50-200 units, 3-10%) was **not taken**, see the evidence section.

### What changed, with before and after

| Item | Before | After |
|---|---|---|
| S1/S2 tools per rung | Artifact, visualize, terminal, ccd_*, mcp-registry, browser servers all loaded | dropped by a generated `disallowedTools` line; `ac-browser` / `ac-browser-opus` variants keep the browser |
| S5 rung bodies (10) | about 880 chars (ac-haiku 2,840; ac-opus-xhigh 3,195) | about 165 (ac-haiku 242; ac-opus-xhigh 2,475 with its self-review block) |
| S5 listing descriptions (10) | 2,759 chars total | 1,473 total (96-161 each) |
| S5 reporting contract | delivered twice in about 71% of spawns | once (spawn-guard to SubagentStart handoff) |
| S4b SessionStart in a compacting subagent | lead-only text re-injected (462 fires in 280 transcripts, mean 5,138 chars) | skipped by memory-budget, self-update, ladder-check, git-brief (capacity-probe, scout-surface and standing rules already skipped) |
| Standing rule `lead-effort-check` | 1,155 chars | 893 |
| Scout line | each repeated kind listed again (15 signals, 4 kinds x4) | each kind once with a count |
| 7 zero-use skill descriptions | 266-381 chars each | 114-157 each (memory-search, evaluate, version, recommend, ac unchanged) |

### S5 root cause (kept for the record)

The SubagentStart payload carries no prompt (session fields, `agent_id`, `agent_type`). `hooks/subagent-brevity.mjs` checked `p.agent_prompt` for the contract marker, which is never present, so it re-injected the contract whenever spawn-guard had already appended it. Fix: spawn-guard records each append as one small file under `state/contract-pending/` (per session, 3-minute expiry, no lock: create and unlink are atomic, and the guard must not load the lock helper on every spawn, which `premium-window-lock.test.mjs` pins); SubagentStart consumes one record per start. A repeat start for the same agent id is skipped (exclusive-create marker). A start with no record, an expired record or unreadable state still reinforces. One accepted gap: if another hook's `updatedInput` wins and drops the append, the record exists but the contract was lost; it cannot be told apart from the payload.

### Contract and report-file fix

Claude Code 2.1.286 refuses a **subagent** Write whose basename matches `/^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i` (subagents only, Write only, basename prefix only). The contract's "file path plus summary" invited those names. It now says: final message carries STATUS, blockers and key numbers; longer detail goes to `<task>-detail.md` (or `.json`/`.csv`) with its path in the final message. A unit test pins that the example name does not match the pattern. The vendor lesson records the measured rule and scope, `teammate-reports-to-files` names files by the convention, and a CONTRIBUTIONS_INBOX entry is added. (The two lessons named in the brief had already been renamed: `verify-actual-bound-url`; no worker instruction writing those names was found.)

### Per-server usage, 30 days, 1,175 ladder runs

| Server | Runs using it | Where | Decision |
|---|---|---|---|
| Claude_Browser | 39 | sonnet-high 19, sonnet-xhigh 5, opus-xhigh 4, opus-medium 3, sonnet-medium 2, opus-high 2, opus-low 2, haiku 1, sonnet-low 1 | dropped from the rungs; kept on `ac-browser` (sonnet/high, 49% of use) and `ac-browser-opus` (opus/medium) |
| claude-in-chrome | 4 | sonnet-high 1, sonnet-medium 3 | dropped (reachable through the variants) |
| computer-use | 0 | none | dropped (27 tool names plus about 5.1K chars of instructions) |
| ccd_session | 17 | sonnet-high 10, others | dropped (mark_chapter / spawn_task belong to the lead) |
| ccd_session_mgmt | 9 | haiku 2, others | dropped except on `ac-haiku` |
| Artifact | 7 | scattered | dropped |
| terminal | 1 | | dropped |
| visualize | 0 | | dropped |
| mcp-registry | 1 | | dropped |
| scheduled-tasks | 11 | | kept (about 65 tokens of names) |
| agent-bus (plugin 24, connector 18), cloudflare-docs 25, cloudflare-api 5 | used | | kept |

`disallowedTools` is written at server level only (`mcp__<server>`), no account-specific connector ids. Documented glob forms are `mcp__<server>__*` and `mcp__*`; no `mcp__ccd_*` pattern is documented, so none is used. Evidence: Claude Code docs for the subagent `disallowedTools` field and the 2.1.286 agent schema.

### Alternatives considered

- Browser: one extra rung vs a variant per tier. Two variants (sonnet/high, opus/medium) cover 49% and 28% of measured use; variants sit beside `ladder` in config (`ladderVariants`) so "/10", escalation and `rungFor` are untouched while every guard still counts them.
- `disallowedTools` per tool name vs per server: per server, so a new tool on a dropped server is dropped too.
- spawn-guard: a general-purpose spawn whose brief names the browser or Artifact is not auto-swapped to a rung (a rung cannot do that work); a ladder spawn naming them gets a note naming the variant.
- S5 handoff vs raising the marker check: the payload has no prompt, so a pending-count handoff is the only signal available.

### S3 (omitClaudeMd): not taken, evidence

The key exists for plugin agents (2.1.286 schema; managed policy files are kept; the built-in Explore and Plan agents use it), so it would work. Guards that fire inside a subagent: destructive git needs a pushed backup, no-verify, protected pm2, junction rm, bare playwright (global command-guard), and code writes to a primary or auto worktree through Write/Edit (write-target-guard). Rules a worker would lose that no guard enforces:

| Project | Unenforced rules a worker would lose |
|---|---|
| Product app repo (mobile and web) | no WSL; version bumps only at the staging merge; commit format; preview tools are orchestrator-only; lint before done |
| Infrastructure orchestrator repo | never print or commit a secret; bind only the one port; never read a credential over SSH to call the API; never mutate sibling trees through Bash; run git/node as the service user; branch naming |
| Stats site repo | changelog entry in the same commit; co-author trailer; docs discipline |
| Product repo in its scoping phase | no scaffolding before an ADR; the private/shared boundary needs a same-tier reviewer; the constraints doc is binding |
| Marketing site repo | brand voice via a content doc; dev-config lands on main as a chore; dev-server port probing |
| Public planner tool repo | co-author trailer; no Options API; a build spec is the spec (husky covers lint, typecheck and build) |

Forgone saving: about 4-5K tokens of cache-read context per spawn. The worker-rules paragraph was not added (it only matters if CLAUDE.md is omitted). Decision logged in the operator's decision log with the reverse path; a narrower variant (read-only rungs only) stays possible.

### Verify in a fresh session (operator)

`plugins/agent-companion/docs/lean-verification/README.txt`: three probe agents (control, `disallowedTools` copy of the rungs, `omitClaudeMd` only), `inspect-subagent.mjs` (tools by server, deferred names by server, MCP instruction servers, injected instruction files, contract count, with PASS/FAIL lines) and `mcp-usage.mjs`. Expected: schemas drop; whether deferred names and the instruction block drop too is the open question. If only schemas drop, the saving is the schema share only and the per-server list should be trimmed to what pays.

### Tests

New: `ladder-browser`, `audit-memory-subindex`, `session-start-subagent`, `scout-surface-dedupe`, `skill-descriptions`; extended: `brevity` (contract once, handoff, file-name pattern), `agent-description-drift` (tools-drift, variants), `delegation-guard`, `ladder-check`, `gate-messages`, `lead-effort-check`. Results: see the CI run on this PR and the local run recorded in the final report.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
