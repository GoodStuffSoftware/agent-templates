# Feasibility: converting `CLAUDE.md` → `AGENTS.md`

**Date:** 2026-09-22
**Revision:** 2 — wave 2 added Antigravity as the Google target (replacing Gemini CLI), refreshed all four ecosystems to current state, and **corrected the fencing recommendation from revision 1, which was wrong.**
**Method:** six research tracks plus two adversarial verification passes. Vendor claims rest on live primary sources fetched 2026-09-22; the Antigravity section is additionally corroborated against the copy installed on this machine.

---

## Bottom line

| Question | Answer |
|---|---|
| 1. Will Claude keep performing as it does today? | **Yes — via a one-line `CLAUDE.md` that imports `AGENTS.md`.** A bare rename silently degrades in eight named situations. |
| 2. Can Gemini, ChatGPT/Codex and Copilot use the converted files as they are? | **Yes, all three — once "Gemini" means Antigravity.** Codex reads `AGENTS.md` (32 KiB silent truncation). Copilot reads it (outranked by its own file). Antigravity reads it (confirmed in its shipped binary). |
| 3. Can other agent systems use our plugin as-is? | **No.** Skills travel everywhere unmodified; the 9 hooks travel nowhere. A cross-vendor standard exists that Anthropic is absent from — and it excludes hooks by design. |

---

## 1. Claude Code parity

`AGENTS.md` support landed in **v2.1.277 (2026-09-18)**.

**Default precedence is not a merge.** The default mode (`claude-md-or-agents-md`) reads `AGENTS.md` **only when no `CLAUDE.md` or `CLAUDE.local.md` exists anywhere in the directory chain**. Loading both requires `pluginConfigs["agents-md@builtin"].options.instructionFiles = "claude-md-and-agents-md"`.

### What a bare rename costs

| Loss | Symptom |
|---|---|
| Unavailable on Bedrock / Vertex / Foundry, telemetry-disabled sessions, first session after an upgrade | Claude runs with **zero project instructions**, silently |
| No `~/.claude/AGENTS.md` equivalent | The user-global rules file must stay `CLAUDE.md` |
| `InstructionsLoaded` hooks do not fire | **agent-companion's own audit tooling goes blind on the converted file** |
| `/memory` and `/context` stop listing it | Loses the browse/edit entry point |
| `/init` never targets it | A later `/init` creates a second, drifting `CLAUDE.md` |
| `--add-dir` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` stops working | Shared config directories stop contributing |
| No `AGENTS.local.md` | No gitignored local-override variant |
| Org kill-switches (`disableAllHooks`, `allowManagedHooksOnly`, disabled `agents-md` plugin) | Falls back to CLAUDE.md-only |

Size behaviour, corrected from revision 1: Claude Code loads the file **in full up to 4 MiB and skips it entirely beyond that** — it does not truncate. The 200-line guidance is soft advice, not enforcement.

### State of this machine (checked, not assumed)

- Claude Code IDE extensions: **2.1.120** (inside Antigravity) and **2.1.202** (inside Cursor) — both below the 2.1.277 gate.
- Claude desktop app: **2.2553.1** (its own version line; bundled CLI version not recoverable from disk — `/status` settles it).
- No `agents-md` plugin in the local plugin cache; no `instructionFiles` setting present.
- **Zero `CLAUDE.local.md`** under `~/dev` (full recursive scan) — the silent-blocker scenario does not apply.

The recommended shape is **version-independent**, so the unresolved version question does not block the decision.

---

## 2. Cross-vendor readability

**Gemini CLI is no longer the Google target.** Google sunset it for free/Pro/Ultra tiers on **2026-06-18**, replaced by **Antigravity**. It survives only for Enterprise/Standard-license and Gemini Enterprise Agent Platform API-key users. Antigravity IDE **2.5.5** is installed on this machine.

| Vendor | Reads `AGENTS.md`? | Reads `CLAUDE.md`? | Notes |
|---|---|---|---|
| **OpenAI Codex** | Yes, default | **No — zero awareness** | **Silently truncates at 32 KiB** (`project_doc_max_bytes`). The request to add a warning was closed *not planned* (#7138, 2026-03-02); #13386 remains open. Treat as permanent. |
| **GitHub Copilot** | Yes, default | **Yes — but only in agent modes** (see below) | Also reads `.claude/CLAUDE.md`, `.claude/rules/*.md`, `~/.claude/CLAUDE.md`, and `.claude/skills`. `.github/copilot-instructions.md` and path-scoped `.instructions.md` outrank `AGENTS.md`. Nested `AGENTS.md` still experimental in VS Code. |

**Copilot's `CLAUDE.md` ingestion is surface-specific, not universal** — corrected from an earlier reading. Per GitHub's own support matrix:

| Copilot surface | Reads `CLAUDE.md`? |
|---|---|
| VS Code **Cloud Agent** mode | Yes |
| JetBrains **Cloud Agent** mode | Yes |
| github.com **Copilot Coding Agent** | Yes |
| **Copilot CLI** | Yes — repo root, cwd, intermediate and nested dirs |
| VS Code / JetBrains plain Copilot Chat | **No** |
| github.com Copilot Chat (web) | **No** |
| Copilot Code Review | **No**, on any surface |
| Visual Studio (the IDE) | **No** — absent from the matrix |
| **Google Antigravity** | Yes — confirmed in the shipped binary | **No — zero hits anywhere** | Reads `AGENTS.md` and `GEMINI.md` as "Rules". Precedence vs. a coexisting `GEMINI.md`, and a claimed 12,000-character cap, are single-source and UNVERIFIED. |
| Gemini Code Assist / Android Studio | Yes, default | — | A real divergence inside Google's own product line. |

### Content compatibility

Most Claude-specific constructs land as **inert text** elsewhere — skill-trigger tables, subagent/hook/plugin references, model-routing tables, frontmatter. They cost tokens; they do not execute.

**`@path` import syntax is the exception, and it is a hazard in two of three vendors:**

| Vendor | Behaviour on `@path` |
|---|---|
| Claude Code | Expands (this is the mechanism we want) |
| **Copilot** | **Expands** — inside `CLAUDE.md`, `AGENTS.md` and `copilot-instructions.md` (not in `.instructions.md` / `GEMINI.md`) |
| **Antigravity** | Has its **own** resolver — will likely reinterpret a Claude-targeted `@path` against its own rules. Medium confidence |
| Codex | Inert |

**Unsettled (residual risk):** what a skill-less tool does with *"invoke the `team-orchestration` skill first"*. No vendor evaluation exists either way. Wave 1 reasoned "silent non-compliance"; one Anthropic bug report (`claude-code#10001`) shows a **third** pattern — the model substituted a plausible *real* tool for the nonexistent one. One data point, not a rule, but substitution is the worst of the three outcomes.

---

## 3. Plugin portability

`agent-companion` is 65 files: 1 manifest (24-key `userConfig` → `CLAUDE_PLUGIN_OPTION_*` env vars), 9 hooks + 6 lib helpers, 10 `SKILL.md`, 1 scheduled routine, 15 scripts, 17 tests, 2 shims, **0 MCP servers**.

### What travels with zero conversion

- The 10 `SKILL.md` bodies. **Copilot reads `.claude/skills` literally, unmodified, on by default.** Codex reads `.codex/skills/`; Antigravity reads `.agents/skills/` (open Agent Skills spec — but it does **not** scan `.claude/skills`).
- All 204 `lessons/*.md`.
- The 15 `scripts/*.mjs` as standalone Node CLIs — caveat: several read Claude-shaped *data* (transcript JSONL, `~/.claude/projects/*/memory/`).
- `config/model-tiers.json`, `compose.mjs`, `leak-check.mjs`.

### What travels nowhere

**The 9 hooks — the plugin's entire enforcement value.** `spawn-guard.mjs` intercepts `PreToolUse` on `^Agent$` to rewrite the model *before the spawn happens*.

| Target | Verdict on the hooks |
|---|---|
| **Codex CLI** | Cheapest port — near-identical event names, `hookSpecificOutput` nesting, `updatedInput` field. Mostly a matcher rename. `.codex/agents/*.toml` has `model_reasoning_effort`, a real analogue of our model+effort pair. But Codex models subagent lifecycle via `SubagentStart`/`Stop`, which fires *after* the spawn decision. |
| **GitHub Copilot** | Real translation work — unnested output, `modifiedArgs` not `updatedInput`. Two distinct targets under one brand (interactive vs. github.com cloud agent). |
| **Antigravity** | Hooks are real and locally confirmed (`.agents/hooks.json`; binary-confirmed events `PreToolUse, PostToolUse, PreInvocation, PostInvocation, SessionStart, SessionEnd`). `invoke_subagent` is a matchable `PreToolUse` tool name — **the interception point exists.** But the documented return contract is `decision` / `reason` / `permissionOverrides` with **no `updatedInput` analogue**: you could *block* a spawn, but nothing confirms you could *rewrite the model* on it. **This single unverified field is what a port lives or dies on.** Subagents use `model: inherit\|flash\|pro` — a three-tier enum, not arbitrary model IDs, with no effort analogue, so our routing table does not map cleanly. |

### The strategic finding

**Agent Plugins 1.0.0**, published **2026-08-06**, governed by a TSC of **AWS/Amazon, Anysphere (Cursor), Microsoft, OpenAI and Vercel**, with **Google joining as a core maintainer**.

- Standardizes **skills and MCP**. **Hooks are explicitly out of scope.**
- **Anthropic is absent from its governance**, with no statement since launch.
- Claude Code cannot natively consume or export the format — though a third-party CLI translates AP1.0 packages into `.claude-plugin` format, so an indirect path exists.
- **Antigravity is not a shipping implementer.** Its `plugin.json` uses Google's own schema namespace; the announcement names Agents CLI and Data Agent Kit instead. Google's TSC membership does not imply Antigravity conformance.

The standard covers precisely the part of our plugin that already travels, and excludes precisely the part that doesn't.

---

## 4. Recommended shape

```
AGENTS.md                    # shared, tool-agnostic content — what every vendor should see
CLAUDE.md                    # one line: @AGENTS.md
```

**Why not a bare rename:** the eight silent-degradation modes in §1.

**Why not a symlink:** Windows needs Administrator or Developer Mode, and a clone without `core.symlinks` turns it into a one-line text file that silently loses everything. This is a Windows box.

### On fencing Claude-only content — revision 1 was wrong

Revision 1 recommended hiding Claude-only doctrine in `.claude/orchestration.md`, imported from `CLAUDE.md`. **That does not work.** Copilot expands `@path` imports inside `CLAUDE.md`, and separately reads `.claude/CLAUDE.md`, `.claude/rules/*.md` and `~/.claude/CLAUDE.md` directly.

The accurate position is narrower and more useful than "nowhere is safe":

- **Codex and Antigravity both ignore `CLAUDE.md` entirely.** Anything kept there is already invisible to two of the three.
- **Copilot is the sole leak.** It reads every `CLAUDE.md`-family location tested, and expands imports out of them.
- **This is already true today, before any conversion.** If Copilot runs anywhere on this machine, it is already ingesting the global `~/.claude/CLAUDE.md`.

**Can Copilot be told to stop? Checked — effectively no.**

- `chat.useClaudeMdFile` is a real VS Code setting and does disable `CLAUDE.md` ingestion there. But it is **a VS Code client setting only** — nothing ties it to Copilot CLI or the github.com coding agent, which are the surfaces most likely to read the repo. And it **does not suppress `.claude/rules/*.md`**, which keep loading through the generic pattern-based path; Microsoft closed the request to fix that as *not planned*.
- **Content exclusion does not reach instruction ingestion.** GitHub's docs frame it around completions and retrieved context, and a GitHub engineer states it is unsupported in Edit and Agent modes of Copilot Chat, Copilot CLI and the Coding Agent — exactly the modes that load `CLAUDE.md`.
- No precedence-based suppression and no size cap: `.github/copilot-instructions.md` **outranks but does not displace** the others; the matrix lists them as additive.

So the only durable control is **a content decision, not a settings toggle**: keep Claude-only doctrine out of the files Copilot's support matrix names (`CLAUDE.md`, `.claude/rules/*.md`, `AGENTS.md`).

That leaves two workable positions:

1. **Accept exposure (recommended).** Copilot's four agent surfaces see the doctrine; it is inert text there. Cost is tokens plus the small substitution risk in §2 — not misbehaviour. Keep the doctrine short for this reason.
2. **Move doctrine into a skill.** `.claude/skills` is read by Copilot, but skills are progressive-disclosure — loaded on invocation rather than always-on. A Claude-orchestration skill is unlikely to be invoked by Copilot, so this reduces steady-state exposure without relying on a toggle. It does not eliminate the possibility.

Either way, the four non-agent Copilot surfaces, Codex and Antigravity never see it.

**Size discipline:** keep `AGENTS.md` under 32 KiB or Codex drops the tail silently. Current global `CLAUDE.md` is 9,412 bytes — comfortable.

**`@path` discipline:** confine `@` imports to `CLAUDE.md`, never `AGENTS.md`. Copilot and Antigravity will both try to resolve them, against different rules.

---

## 5. Migration order

**Fix the plugin first. Rename second.** There are ~90 `CLAUDE.md` files already materialised across local projects, the majority of them worktree copies of a single project ({{PROJECT}}), plus the global `~/.claude/CLAUDE.md`. A literal string swap blinds agent-companion on all of them — silently, in all five cases.

### Hard blockers — 5 sites needing accept-either-filename logic, not a swap

| # | Site | Failure mode if swapped blindly |
|---|---|---|
| 1 | `plugins/agent-companion/hooks/memory-budget.mjs:68-69` | Silent no-op — `existsSync` false, candidate skipped |
| 2 | `plugins/agent-companion/scripts/checks.mjs:155-156` | Same pattern; duplicated logic worth consolidating |
| 3 | `plugins/agent-companion/scripts/checks.mjs:168` | Separate `label.includes('CLAUDE.md')` gate — needs its own fix |
| 4 | `plugins/agent-companion/hooks/lib/memory-index.mjs:419` | Silent wrong result — default glob stops matching |
| 5 | `plugins/agent-companion/.claude-plugin/plugin.json:181` | Same literal default; must move in lockstep with #4 |

### Then, in order

6. Rename `anthropic/basic-site/CLAUDE.md.template`; swap its 5 internal prose lines.
7. Update `HYDRATION.md` (8 hits) — the only place the consumer output filename is specified, and it is **prose only; no script enforces it**.
8. 23 agent-instruction hits across 9 files — prefer filename-agnostic wording; hydrated consumer projects will be mixed for a long time.
9. 41 doc-prose hits — cosmetic, lowest priority.

### Outside this repo's reach

The harness's own load behaviour; the ~90 materialized `CLAUDE.md` files already in place across local projects; the global `~/.claude/CLAUDE.md`; `~/.claude/skills/session-chaptering` and `team-orchestration`; every `{{PROJECT}}*` worktree's `{{PROJECT_PREFIX}}-*.md` definitions; plugin-cache copies.

**Clean:** `compose.mjs` and `leak-check.mjs` have zero dependency on the filename. No CI workflow or test asserts on it. Zero occurrences of `AGENTS.md` in the repo today.

---

## 6. Residual risk

| Item | Status |
|---|---|
| Can Copilot be told not to read `CLAUDE.md`? | **Closed — effectively no.** One VS-Code-only toggle exists, leaky and client-local; content exclusion does not cover agent modes. Fencing is a content decision. |
| Antigravity `PreToolUse` return contract — is there an `updatedInput` analogue? | **Unverified. A plugin port lives or dies on this.** |
| Bundled Claude Code CLI version in the desktop app | Unresolved; `/status` settles it. Does not block the recommendation. |
| What a skill-less tool does with "invoke skill X" | No vendor evaluation. Three candidate behaviours observed across one bug report; substitution is the worst case. |
| Antigravity precedence vs. `GEMINI.md`, and its claimed 12,000-char cap | Single-source, uncorroborated locally. |
| Antigravity Agent Plugins 1.0 conformance | Not a shipping implementer; own schema namespace. |
| Gemini CLI "closed-source successor" characterization | Convergent sources; no explicit Google statement. |

---

## Appendix: documentation defects found

Worth knowing, because they affect how much any single doc page should be trusted here:

- An Antigravity docs page **denies `AGENTS.md` support**, contradicted by its own shipped binary and by Google's migration doc.
- Antigravity docs list a `Stop` hook event that **does not appear in the binary**; the binary instead carries `SessionStart`/`SessionEnd`, which the docs omit.
- A third-party blog claimed Copilot CLI does not read `AGENTS.md`; official GitHub docs say it does.

In each case the empirical or primary source won. Any fact in this report sourced to a single doc page is labelled UNVERIFIED for exactly this reason.
