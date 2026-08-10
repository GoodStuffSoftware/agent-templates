---
id: clean-clone-cross-os-build-truth
title: A repo only ever built in place on its authoring OS hides clean-clone and permission-bit breakage — build it from a fresh clone on the target OS
scope: [universal, stack:git]
requires: { stack: git }
status: active
since: 2026-07-27
provenance: [contrib-2]
corroborated: 2
---
A long-lived working tree on the machine where the code was written is the most forgiving environment the repo will ever see, and it masks at least two classes of defect that are certain to bite the first host that builds from a fresh clone on another OS:

- **Committed generated scaffold drifting from its source manifest.** When a build step regenerates a file that is also committed, adding a dependency makes the generator emit new entries — and the build now dirties the working tree on every run. Locally that dirt reads as background noise and gets ignored. On a builder that clones clean and enforces a clean tree before deploying, the same drift is a hard stop.
- **POSIX permission bits.** A wrapper or entry script committed with a non-executable mode works fine on a filesystem that does not track the bit, and fails with a permission error on every fresh checkout that does. The mode is repo content; the authoring filesystem just never showed you that it was wrong.

- **Every gitignored build input.** A deploy that builds in a throwaway checkout — `git worktree add`, a clean clone, a container build context — populates only TRACKED files. Local machine-specific config that the build genuinely needs and that is deliberately gitignored (SDK locations, signing config, path files) is therefore silently ABSENT there, and only there. In one release pipeline this was the shared cause behind three of four consecutive deploy failures, each one only visible once the previous had been cleared.

Both are invisible for exactly as long as nobody clones. Neither is caught by tests, lint, or review — only by doing the thing.

**Why:** Incremental in-place builds carry accumulated state that substitutes for correctness: the scaffold is already right because a previous run wrote it, the script is already executable because the checkout that created it said so. The defect is in what the repo *fails to record*, and only a build with no accumulated state can observe an absence. The failure also lands at the worst moment — on the deploy path, on a host nobody was watching, in a step that had been green for months.

**How to apply:**
- Treat "the working tree is dirty after a build" as a defect, never as noise. It means a committed generated artifact no longer matches its source manifest — regenerate and commit it, and keep the clean-tree gate that surfaced it.
- Set the executable bit explicitly in the index for every wrapper/entry script (`git update-index --chmod=+x {{SCRIPT_PATH}}`), and check it after any script is added from a filesystem that ignores modes.
- Run at least one build from a fresh clone on the target OS, on a schedule or in CI. In-place incremental builds never exercise this path, so it has to be someone's explicit job.
- When a generated file is committed on purpose, note in the repo what regenerates it and what invalidates it — the next dependency change is the next drift.
- **When a gitignored file is a build input, supply it at the environment level, not per-checkout.** Setting the tool's environment variable on the build host fixes every future build; writing the ignored file into one throwaway tree fixes exactly one. And when the input is genuinely per-project, have the build *generate* it from tracked sources rather than expecting it to be there.
- **A pre-flight that short-circuits before authenticating is not a pre-flight.** One pipeline's validation step documented itself as surfacing an auth failure early; it actually bailed on "no artifact found" before ever authenticating. Check credentials against the real API directly — mint a token, open and immediately discard an ephemeral resource — rather than trusting a wrapper's claim to have checked ([[match-instrument-to-failure-class]]).
- **`exit null` / "the process never spawned" is a different fault from "it ran and refused."** A missing runtime on the build host reads, through several layers of wrapper, as an application error. Distinguish the two before debugging the application.
- Pairs with [[content-guard-honors-gitignore]]: what the repo commits, and what it merely happens to contain locally, are different sets — gates should reason about the former. See also [[lifecycle-hook-runs-in-production-installs]] for the manifest-side sibling.
