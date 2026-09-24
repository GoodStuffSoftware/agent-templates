# Task-pack format

A task pack is a benchmark task sourced from a REAL fix commit in a local
git repository, without ever committing that repo's extracted source into
this plugin. The repo path is always a RUNTIME parameter (`--repo`); a pack
directory holds only:

```
<pack-dir>/
  manifest.json     # required — see schema below
  report.md          # required — hand-written, symptom-only bug report
  hidden-test.mjs     # required — the held-out check, see "Hidden test contract"
  rubric.md           # optional — design rubric for the rubric judge, see "Rubric and judge calibration"
```

Nothing else. In particular: **no extracted source files.** `setup()` pulls
the parent-commit content of `manifest.files` out of the repo with
`git show <parentRef>:<path>` fresh on every run (`extractFilesAtRef()` in
`lib.mjs`) — this is what "extracted at run time" means. A pack committed to
this plugin is therefore just a report + a test + a pointer (two git refs
and a file list); the actual buggy/fixed source lives only in the target
repo's own history, exactly as the plugin's own leak-check policy requires
(no proprietary or excessively identifying source content shipped here).

## Contamination control is deliberate

Sourcing packs from a **private, local repository and extracting them at run
time** is not only a way to keep source out of this public repo. It is also
the benchmark's contamination control. Public agentic-coding benchmarks
(the SWE-bench family) lose signal once their tasks and fixes reach training
corpora: a model that has seen the fix scores like a model that can find it.
A fix commit that lives only in a private repo's history, and never in this
plugin or anything public, is not in any training set. So a pass measures
capability, not recall. The same reasoning is why `report.md` is written
fresh (symptoms only) and `leakPhrases` keeps the commit's own wording out of
the sandbox.

The committed example pack (`examples/leak-check-gitignore-fix`) draws on
this PUBLIC repository's own history. It demonstrates the mechanics only; it
is not a contamination-controlled task, and its results say nothing about
capability.

Two consequences:

- **Keep the source repo private.** If a pack's source repo is ever made
  public, mirrored, or published, treat its packs as contaminated for every
  model generation trained after that date, and retire or replace them.
- **Re-verify packs when a new model generation ships.** Run
  `verify-pack.mjs` against each pack (fail-at-parent / pass-at-fix must
  still hold) and re-read `report.md` for anything that has since become
  public knowledge. A sudden jump to 100% on a pack that older generations
  failed is either real progress or memorisation. Before crediting the new
  model, check whether the fix, or a discussion of it, became public between
  the two generations.

## manifest.json schema

```jsonc
{
  "id": "leak-check-gitignore-fix",     // task id, used with scripts/benchmark.mjs --tasks
  "parentRefB64": "<base64 of the git ref>", // the BUGGY state the model will see. BASE64,
                                          // never plaintext -- a raw git SHA is exactly the
                                          // shape this plugin's own leak-check.mjs bans
                                          // (git-sha-like, 7-40 contiguous hex chars), and a
                                          // real commit ref genuinely has that shape. Same
                                          // technique leak-check.mjs uses for its own banned
                                          // tokens: encode at build time (encodeRef() in
                                          // lib.mjs), decode only at load time, never store
                                          // plaintext. build-pack.mjs does this for you --
                                          // pass plain --parent/--fix refs on the command line.
  "fixRefB64": "<base64 of the git ref>", // the known-good state, used only by
                                          // build-pack.mjs/verify-pack.mjs to prove
                                          // fail-at-parent/pass-at-fix -- never shown to a model
  "files": ["scripts/leak-check.mjs"],   // repo-relative paths extracted into the sandbox,
                                          // preserving their relative path (a file's own
                                          // __dirname-relative logic, e.g. "../", must keep working)
  "leakPhrases": ["gitignored PROVENANCE.local.md", "honor .gitignore"],
                                          // commit-message / diagnosis phrases that must NEVER
                                          // appear in the extracted sandbox -- checked by
                                          // assertNoLeakedFixLanguage() on every setup(), not just
                                          // at build time (a future edit to files[] could
                                          // reintroduce one)
  "maxBudgetUsd": 0.6,                    // per-run --max-budget-usd ceiling for this task
  "expectedFiles": ["scripts/leak-check.mjs"],
                                          // extra sandbox-relative paths the model is allowed to
                                          // touch/create beyond files[] itself and the guard file
                                          // (finalizeScore's scope check flags anything else)
  "judgeCalibration": {                   // OPTIONAL, only meaningful with rubric.md
    "plantedBad": [                       // known-bad variants of the FIX: each is one
      { "note": "tracked files only",     // find/replace applied to the fix-ref content.
        "file": "scripts/leak-check.mjs", // Keep find/replace SMALL -- a snippet, never
        "find": "<exact text in the fix>",// extracted source
        "replace": "<broken version>" }
    ]
  }
}
```

`report.md` is the ENTIRE prompt body handed to the model (plus a fixed
footer `buildTaskFromPack()` appends: sandbox scope, the `CLAIM:` line
convention, and the guard-file warning). It must describe only the
SYMPTOM — what was observed, never the diagnosis, the file/function at
fault, or language lifted from the fix commit's own message. This is the
same discipline `bench/PROCESS-NOTES.md`'s real-history ADR documents for
the pre-baked `real-*` tasks; `leakPhrases` is the automated tripwire on
top of writing it carefully.

## Hidden test contract

`hidden-test.mjs` exports a single default function:

```js
export default async function check(sandboxDir) {
  // ... run/verify something against the FINAL sandbox tree ...
  return { pass: true | false, detail: '<short reason, always present>' };
}
```

It receives the sandbox directory AFTER the model's run (or, during
`verify-pack.mjs`, after a fresh extraction at `parentRef`/`fixRef` with no
model involved at all). It may shell out (`node:child_process`) to run the
target file directly — that is normal for a CLI-shaped fixture like the
example pack's `leak-check.mjs` — but must never read anything outside
`sandboxDir`, and must never import or `readFileSync` a file that names the
fix commit, its message, or CHANGELOG/docs text (same leak-guard discipline
as `files[]`/`leakPhrases`).

## Verification: fail-at-parent, pass-at-fix

`build-pack.mjs` (when creating a pack) and `verify-pack.mjs` (to re-check
one later, e.g. after editing `hidden-test.mjs`) both run the SAME
`verifyPack()`:

1. Extract `files[]` at `parentRef` into a throwaway sandbox; run
   `hidden-test.mjs`'s `check()`; require `pass === false`. Also runs the
   `leakPhrases` grep here — this is the ONLY state a model in a real run
   ever sees, so it's the only extraction the leak-phrase check applies to.
2. Extract `files[]` at `fixRef` into a throwaway sandbox; run the same
   `check()`; require `pass === true`. No leak-phrase check here — the real
   fix's own source comments legitimately explain the fix in the commit
   message's own terms, which is not a leak of anything a model had to earn.
3. A `.git`-absence check against BOTH extracted trees (extraction must use
   `git show`, never `git clone`/`git checkout`).

A pack that fails any of these is not usable as a benchmark task — the
hidden test either doesn't detect the real bug, or the fix doesn't actually
satisfy it, or the sandbox leaks the answer. `build-pack.mjs` reports this
loudly rather than silently writing a broken manifest.

## Rubric and judge calibration

`rubric.md` (optional) is the rubric the optional rubric judge
(`bench/judge.mjs`, docs/BENCHMARK.md "Rubric judge") grades each run's
change against. Use it for design quality the hidden test cannot see: fixing
the real cause rather than special-casing the test, staying in scope, not
weakening a check. Write concrete **PASS if ALL** and **FAIL if ANY**
conditions. The same fairness rule as the hidden test applies: grade only
what the report states or implies, never something only the fix commit
knows.

A pack with a rubric calibrates the judge for free. The real fix commit's
change is the **known-good**. The unchanged parent, plus every
`judgeCalibration.plantedBad` variant, are **known-bad**. The judge is
trusted on the pack only after it passes the first and fails all the others
(`scripts/benchmark.mjs --calibrate-judge`). The best planted variant is one
a lenient hidden test would still pass, for example the example pack's
"tracked files only" variant. That is exactly the case the judge exists to
catch. A `find` string that no longer matches the fix fails calibration
loudly rather than silently testing nothing. Editing `manifest.json`,
`report.md`, `hidden-test.mjs` or `rubric.md` changes the pack's content hash
(`packContentSha256()`, also logged on every result row as
`task_pack_sha256`), which invalidates any earlier calibration.

## Building a new pack

```bash
node bench/task-packs/build-pack.mjs \
  --repo <path to a local checkout> \
  --id my-pack-id \
  --parent <parent-sha> --fix <fix-sha> \
  --files path/one.mjs,path/two.mjs \
  --report /path/to/hand-written-report.md \
  --hidden-test /path/to/hidden-test.mjs \
  --leak-phrases "phrase one,phrase two" \
  --max-budget-usd 0.8 \
  --out bench/task-packs/examples/my-pack-id
```

Re-verify an existing pack later (e.g. after touching `hidden-test.mjs`, or
against a re-cloned copy of the source repo):

```bash
node bench/task-packs/verify-pack.mjs --pack bench/task-packs/examples/my-pack-id --repo <path>
```

## Using a pack in a benchmark run

`scripts/benchmark.mjs --task-pack <dir>[,<dir>...] --pack-repo <path>` merges
every named pack's task into the runnable set (task id = `manifest.id`),
selectable via the normal `--tasks` flag alongside the built-in easy/hard/
real tasks. `--pack-repo` is the repo path used for the `git show` extraction
at run time — the pack directory itself never carries one.
