# Self-review protocol, long form

The short rules a writer acts on are in the self-review block of its agent body (generated from `config/model-tiers.json` `selfReview`; `<plugin>` below is the agent-companion folder, the one above the `scripts/git-brief.mjs` your start-up context names). This file holds what the block links to, so it is read only when a review applies instead of sitting in every writer's context from the first call (0.31.65: the block went from about 10,000 to about 4,000 characters).

Why a writer reviews its own work, the cost history and how to reverse it: the `rationale` field of `selfReview` in the config. Reviewers never spawn reviewers; the spawn guard denies it.

## API review

Run this only when your cell has a reviewer that reads (not one that checks the running app) and `node "<plugin>/scripts/api-credits.mjs" decide review` printed `api`. One decision per review: the counter moves once. The reviewer you spawn does not carry `API: no` (that line is only the retry marker after a recorded API failure; the guard ignores it otherwise). If `decide review` printed `plan`, add the line `API: plan` to the reviewer brief so the guard does not decide a second time; `API: plan` is the deliberate opt-out of API routing.

1. Write the reviewer brief (the lead's brief TEXT goes into the file, never only a path to it: the runner sends the file's text and its tools cannot read outside the repository).
2. Run, in the background (`run_in_background`), then wait for its notification (a review is not cut by the clock: it logs itself at 8 minutes and goes on; a foreground Bash call is cut at 10 minutes and kills it mid-run):

   `node "<plugin>/scripts/api-review.mjs" run --brief-file <file> --diff-ref <base>..<head> --model <your reviewer model> [--effort <effort>] --writer <your model/effort> --risk <your risk> --review-file <review file> --cwd <your worktree>`

3. The API reviewer only reads (read-only tools, no shell: it cannot run even the targeted tests and says which it would have run). Its stdout is the reviewer's result, with the same VERDICT rules: no verdict line, no land.
4. If `decide review` printed `plan`, or the runner errors or exits nonzero (stdout starts `API review unavailable` or `API review failed`), spawn the subagent reviewer at once. When stdout ends with `(review id: <id>)`, first run `node "<plugin>/scripts/api-credits.mjs" record-fallback <id> --reason "<why>"`, which counts the double-spent review.

## Subagent reviewer brief

After the five opening lines (TYPE, WRITER, ROLE, RISK, API) the brief contains:

- the lead's original brief, verbatim, or the path of a file that holds it verbatim;
- the branch, the commit sha and the diff range under review;
- the raw output of your own test and build runs, and the batch's e2e result when your cell has one (paste it, do not summarise it: you run the checks and the reviewer reads the output, it never reruns your whole check; say in the brief if a check was not run);
- the line "Follow the Reviewer instruction in <plugin>/docs/SELF-REVIEW.md (absolute path); read it first";
- the review file to write: the path the lead's brief names for it, if any; otherwise `REVIEW-<name>.md` next to your report file;
- where to read: its own checkout of that sha (for example `git worktree add --detach <path> <sha>`, run from your working tree), never your working tree; it reads, and runs at most the tests that cover the changed code when they need no build (plus the project's own run command when your cell asks for a check in the running app): no separate builds, no full suite, no e2e, no CI, no commits, no pushes.

Add nothing that narrows the review: no areas to skip, no findings to expect, no summary of your own that stands in for the diff.

## Reviewer instruction

(Kept equal to `REVIEW_INSTRUCTION` in `hooks/lib/self-review.mjs`, which the API runner sends too; a test fails if they drift.)

This review is a READ of the code, and it is adversarial: assume the change is wrong and hunt for what the writer missed. Refute it by reading: the diff, the code it touches, and its callers and consumers (grep and trace the call path), plus the raw test and build output the writer put in the hand-off; say if that output is missing. You may run only the tests that cover the changed code (the test file or module for it, such as `node --test tests/x.test.mjs`), and only when they run with no compile or build step. Never run the full suite, ci-local, e2e or CI (read the batch's result in the hand-off), never rerun the writer's whole check (the writer and CI run those), and do not fix or edit anything: a review takes minutes. The tier clause in this brief, when it has one, decides whether you may run anything beyond those tests: a cell that says read only or by reading means you read and run nothing else, however large the change. Where the cell asks you to check the changed behaviour in the running app, or the brief has no tier clause and its RISK is high or the change is large or risky, you may start the project's own run or dev command, including the compile that command does itself, only to check the touched behaviour for real; run no separate full build, packaging or install, and if the check needs one, write "not checked for real" and why. With no tier clause, a small change is read only. You may raise the writer's RISK, never lower it, and say so on the line after the verdict. Also check the change against the repo's recorded decisions and standards: find its ADR files (docs/adr/, docs/decisions/, ADR-*.md), the project CLAUDE.md and any conventions or contributing doc, and against the established patterns in neighbouring code (naming, error handling, file layout, how similar features are done). A deviation is a finding unless the change also updates or adds the ADR that justifies it; if the repo has no ADRs, say so and check against the patterns alone. Your output is a report to the main agent (the lead or writer that asked for it) of what it missed: defects, gaps against the acceptance criteria, callers and consumers left unhandled, deviations from the repo's ADRs and patterns. Start with a verdict line, `VERDICT: PASS` or `VERDICT: FIX`, then list each finding as blocker, should-fix or nit, with file:line and the reading that shows it (the call path, or the line that contradicts the change).
