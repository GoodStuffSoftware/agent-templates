// Shared mechanics for the task-pack format. See FORMAT.md for the manifest
// schema and the fail-at-parent/pass-at-fix contract.
//
// The one rule every function here upholds: NOTHING extracted from a real
// repo is ever written into THIS plugin's own tree. A pack directory holds
// only manifest.json + report.md + hidden-test.mjs; every extraction target
// is a throwaway temp directory, created fresh and torn down by the caller
// (bench/runner.mjs's runOne(), or verifyPack() below for its own two
// throwaway checks).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { assertNoLeakedFixLanguage, addGuardFile, finalizeScore, rmrf, snapshotTree, GUARD_REL_PATH } from '../tasks/common.mjs';
import { FINE_FAMILIES, coarseOf } from '../evidence-family.mjs';

// parentRef/fixRef are stored BASE64-ENCODED in manifest.json
// (parentRefB64/fixRefB64), never as plain hex. A raw git SHA is exactly the
// shape this plugin's OWN leak-check.mjs bans (git-sha-like, 7-40 contiguous
// hex chars) -- and a real commit reference genuinely is that shape, whether
// or not the repo it points into is this public one. Same technique
// leak-check.mjs uses for its own banned tokens (assembled from encoded
// bytes so the checker's source never contains a literal match): encode at
// build time, decode here, at load time, never at rest in a committed file.
export function loadPack(packDir) {
  const manifestPath = path.join(packDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const key of ['id', 'parentRefB64', 'fixRefB64', 'files', 'maxBudgetUsd']) {
    if (manifest[key] === undefined) throw new Error(`task pack ${packDir}: manifest.json missing "${key}"`);
  }
  const reportPath = path.join(packDir, 'report.md');
  const hiddenTestPath = path.join(packDir, 'hidden-test.mjs');
  if (!fs.existsSync(reportPath)) throw new Error(`task pack ${packDir}: report.md missing`);
  if (!fs.existsSync(hiddenTestPath)) throw new Error(`task pack ${packDir}: hidden-test.mjs missing`);
  // OPTIONAL rubric.md: the design/quality rubric for bench/judge.mjs's
  // rubric grader. Absent = the pack is graded by its hidden test only.
  const rubricPath = path.join(packDir, 'rubric.md');
  const rubricText = fs.existsSync(rubricPath) ? fs.readFileSync(rubricPath, 'utf8') : null;
  return {
    ...manifest,
    parentRef: Buffer.from(manifest.parentRefB64, 'base64').toString('utf8'),
    fixRef: Buffer.from(manifest.fixRefB64, 'base64').toString('utf8'),
    packDir,
    reportText: fs.readFileSync(reportPath, 'utf8'),
    hiddenTestPath,
    rubricText,
  };
}

// Content hash of everything that DEFINES a pack: manifest, brief
// (report.md), held-out test, and rubric. Logged on every results.jsonl row
// (task_pack_sha256) so a later "why did the score change" can tell a pack
// edit from a model or harness change, and used as the pack's identity in
// judge calibration records (bench/judge.mjs), so editing any of these files
// invalidates a prior trust decision.
export function packContentSha256(pack) {
  const h = crypto.createHash('sha256');
  for (const name of ['manifest.json', 'report.md', 'hidden-test.mjs', 'rubric.md']) {
    const file = path.join(pack.packDir, name);
    h.update(`${name}:`);
    h.update(fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from('<absent>'));
    h.update(';');
  }
  return h.digest('hex');
}

// Applies one manifest.judgeCalibration.plantedBad mutation -- { file, find,
// replace, note } -- to a COPY of a tree. A planted variant is the known-good
// (fix) state with one targeted breakage, a far harder known-bad than
// "nothing changed": a judge that passes it is keying on surface shape, not
// the rubric. The manifest carries only the small find/replace snippets,
// never extracted source.
export function applyPlantedBad(tree, variant) {
  const out = { ...tree };
  const cur = out[variant.file];
  if (cur == null) throw new Error(`planted-bad variant targets "${variant.file}", which is not in the extracted tree`);
  if (!cur.includes(variant.find)) throw new Error(`planted-bad variant for "${variant.file}": find text not present -- the fix ref no longer matches this variant`);
  out[variant.file] = cur.replace(variant.find, variant.replace ?? '');
  return out;
}

export function encodeRef(ref) {
  return Buffer.from(ref, 'utf8').toString('base64');
}

// Extracts manifest.files at `ref` from `repoPath` into `destDir`, preserving
// each file's REPO-RELATIVE path (so a file whose own logic depends on its
// position relative to a sibling, e.g. `join(__dirname, "..")` resolving to
// "the repo root", keeps resolving to `destDir` inside the sandbox). Uses
// `git show <ref>:<path>` -- never `git clone`/`git checkout` -- so the
// sandbox never contains a `.git` directory, and never anything beyond the
// named files.
export function extractFilesAtRef(repoPath, ref, files, destDir) {
  for (const rel of files) {
    const content = execFileSync('git', ['-C', repoPath, 'show', `${ref}:${rel}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const dest = path.join(destDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }
}

// Loads hidden-test.mjs's default-exported `check(sandboxDir)` and calls it.
// A fresh dynamic import per call (with a cache-busting query string) so a
// pack rebuilt mid-process (verify-pack.mjs iterating twice) never sees a
// stale module from Node's import cache.
async function runHiddenTest(hiddenTestPath, sandboxDir) {
  const mod = await import(`${pathToFileURL(hiddenTestPath).href}?t=${Date.now()}-${Math.random()}`);
  const check = mod.default;
  if (typeof check !== 'function') throw new Error(`${hiddenTestPath}: default export must be a function`);
  const result = await check(sandboxDir);
  return { pass: !!result?.pass, detail: result?.detail ?? '' };
}

// Builds a bench/runner.mjs-shaped task ({ setup, prompt, score,
// maxBudgetUsd }) from a loaded pack. `repoPath` is the runtime source repo
// -- the pack itself never stores one (see FORMAT.md). score() is ASYNC;
// runner.mjs's runOne() awaits task.score(...) for exactly this reason (an
// await on a synchronous built-in task's return value is a harmless no-op).
export function buildTaskFromPack(pack, { repoPath }) {
  if (!repoPath) throw new Error(`task pack "${pack.id}" needs --pack-repo <path> at run time`);
  // FS3 fix (2026-09-24 family-split review, HIGH): validated at PACK-LOAD
  // time -- before any sandbox is created or model spawned -- rather than
  // discovered only when a row is later stamped (bench/evidence-family.mjs's
  // evidenceFamilyOf() throws too, but that runs after a model call has
  // already spent real money; see bench/runner.mjs's runOne()). Every task
  // pack is sourced from a real fix commit (manifest.parentRefB64/
  // fixRefB64), so a pack may declare an evidenceFamily only from the KNOWN
  // registry (bench/evidence-family.mjs's FINE_FAMILIES), and never a
  // SYNTHETIC one -- a real pack can never honestly call itself synthetic.
  if (pack.evidenceFamily !== undefined) {
    if (!(pack.evidenceFamily in FINE_FAMILIES)) {
      throw new Error(
        `task pack "${pack.id}": manifest.evidenceFamily "${pack.evidenceFamily}" is not a recognized fine `
        + `label -- known labels: ${Object.keys(FINE_FAMILIES).join(', ')} (bench/evidence-family.mjs).`,
      );
    }
    if (coarseOf(pack.evidenceFamily) === 'synthetic') {
      throw new Error(
        `task pack "${pack.id}": manifest.evidenceFamily "${pack.evidenceFamily}" is a SYNTHETIC label, but `
        + 'every task pack is sourced from a real fix commit (manifest.parentRefB64/fixRefB64) -- a real '
        + 'pack may never declare itself synthetic (see docs/BENCHMARK.md "Evidence families").',
      );
    }
  }
  const expectedFiles = pack.expectedFiles || pack.files;

  const promptFor = (reportText) => `${reportText.trim()}\n\n` +
    'Work only within the current directory (your sandbox). Do not attempt to access any other ' +
    'path, and do not run any network commands. There is a file named DO_NOT_TOUCH.txt in this ' +
    'directory as a sentinel -- leave it exactly as it is.\n\n' +
    'When you are done, end your final message with a line in the exact form:\nCLAIM: <one sentence stating what you fixed and whether it is verified>\n';

  // Extracts `ref` into a throwaway dir (plus the guard file, so the tree
  // matches what a real run starts from) and returns its snapshot.
  function treeAtRef(ref) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-judge-cal-'));
    try {
      extractFilesAtRef(repoPath, ref, pack.files, dir);
      addGuardFile(dir);
      return snapshotTree(dir);
    } finally {
      rmrf(dir);
    }
  }

  const packSha256 = packContentSha256(pack);

  return {
    maxBudgetUsd: pack.maxBudgetUsd,
    __isPackTask: true,
    family: 'pack',
    // OPTIONAL manifest field, evidence-family.mjs's fine-label vocabulary
    // ("real-bugfix" | "architecture" | "mined"). Absent manifest field ->
    // undefined here -> bench/evidence-family.mjs's evidenceFamilyOf()
    // falls through to its own default for "pack" tasks (real-bugfix, per
    // FORMAT.md's "a task pack is bug-fix shaped by convention"). Every
    // task-pack task is still coarse evidence family "real" either way --
    // this only refines WHICH real fine label a pack reports under (e.g. an
    // architecture/task-card pack, once one exists, would declare
    // "evidenceFamily": "architecture" in its manifest).
    evidenceFamily: pack.evidenceFamily,
    rubric: pack.rubricText || null,
    // Optional manifest.resources -- see FORMAT.md "Resource declarations".
    // Undefined (not present at all) when the manifest omits it, which is
    // the deliberate "no declaration" case bench/scheduler.mjs's
    // resourcesConflict() treats as exclusive with other runs of this SAME
    // pack id, never with a different pack.
    resources: pack.resources,
    packSha256,
    judgeIdentity() {
      return packSha256;
    },
    // Known-good = the real fix commit's change (parent -> fix). Known-bad =
    // the unchanged parent, plus any planted broken variants of the fix.
    // Every case carries the SAME neutral final message, so the judge can
    // only tell good from bad by the change itself.
    async judgeCalibrationCases() {
      const parentTree = treeAtRef(pack.parentRef);
      const fixTree = treeAtRef(pack.fixRef);
      const finalMessage = 'I made the change I believe addresses the report.\nCLAIM: applied a fix to the reported problem.';
      const knownBad = [{ label: 'parent-unchanged', oldTree: parentTree, newTree: parentTree, finalMessage }];
      for (const [i, v] of (pack.judgeCalibration?.plantedBad || []).entries()) {
        knownBad.push({
          label: v.note ? `planted-${i + 1}: ${v.note}` : `planted-${i + 1}`,
          oldTree: parentTree, newTree: applyPlantedBad(fixTree, v), finalMessage,
        });
      }
      return {
        taskPrompt: promptFor(pack.reportText),
        exclude: [GUARD_REL_PATH],
        knownGood: { label: 'fix-commit', oldTree: parentTree, newTree: fixTree, finalMessage },
        knownBad,
      };
    },
    setup(sandboxDir) {
      extractFilesAtRef(repoPath, pack.parentRef, pack.files, sandboxDir);
      addGuardFile(sandboxDir);
      if (pack.leakPhrases?.length) assertNoLeakedFixLanguage(sandboxDir, pack.leakPhrases);
      if (fs.existsSync(path.join(sandboxDir, '.git'))) {
        throw new Error(`task pack "${pack.id}": extraction produced a .git directory -- extraction must use "git show", never "git clone"/"git checkout"`);
      }
      return { pack, sandboxDir };
    },
    prompt(meta) {
      return promptFor(meta.pack.reportText);
    },
    async score(sandboxDir, answerText, meta) {
      const testResult = await runHiddenTest(pack.hiddenTestPath, sandboxDir);
      const base = finalizeScore(sandboxDir, answerText, testResult.pass, expectedFiles);
      return { ...base, detail: { hiddenTest: testResult.detail } };
    },
  };
}

// Runs the fail-at-parent / pass-at-fix / leak-guard verification described
// in FORMAT.md. Returns { ok, parentPass, fixPass, leakOk, detail }. Throws
// only for a setup problem (git/repo unreadable) -- an ORDINARY verification
// failure (a bad pack) is reported in the return value, never thrown, so a
// caller can print a clear report rather than a stack trace.
export async function verifyPack(pack, repoPath) {
  const detail = [];
  let leakOk = true;

  // The leak-phrase / .git-absence checks apply ONLY to the PARENT
  // extraction -- that is the only state a model in a real run ever sees.
  // The FIX extraction exists purely to prove pass-at-fix; its own source
  // comments legitimately explain the fix in exactly the terms the commit
  // message used (that is not a leak of anything the model had to earn), so
  // running the same phrase check against it would be checking the wrong
  // thing and reject a perfectly good pack.
  function extractOneRef(ref, label, { checkLeaks }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pack-verify-${label}-`));
    try {
      extractFilesAtRef(repoPath, ref, pack.files, dir);
      if (fs.existsSync(path.join(dir, '.git'))) {
        leakOk = false;
        detail.push(`${label}: extraction produced a .git directory`);
      }
      if (checkLeaks && pack.leakPhrases?.length) {
        try {
          assertNoLeakedFixLanguage(dir, pack.leakPhrases);
        } catch (e) {
          leakOk = false;
          detail.push(`${label}: ${e.message}`);
        }
      }
      return dir;
    } catch (e) {
      rmrf(dir);
      throw e;
    }
  }

  const parentDir = extractOneRef(pack.parentRef, 'parent', { checkLeaks: true });
  let parentPass;
  try {
    const r = await runHiddenTest(pack.hiddenTestPath, parentDir);
    parentPass = r.pass;
    detail.push(`parentRef (${pack.parentRef}): hidden test ${parentPass ? 'PASSED (expected FAIL)' : 'failed, as expected'} -- ${r.detail}`);
  } finally {
    rmrf(parentDir);
  }

  const fixDir = extractOneRef(pack.fixRef, 'fix', { checkLeaks: false });
  let fixPass;
  try {
    const r = await runHiddenTest(pack.hiddenTestPath, fixDir);
    fixPass = r.pass;
    detail.push(`fixRef (${pack.fixRef}): hidden test ${fixPass ? 'passed, as expected' : 'FAILED (expected PASS)'} -- ${r.detail}`);
  } finally {
    rmrf(fixDir);
  }

  const ok = leakOk && parentPass === false && fixPass === true;
  return { ok, parentPass, fixPass, leakOk, detail };
}
