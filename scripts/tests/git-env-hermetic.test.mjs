// The repo-level tests create and push throwaway git repositories, and the
// pre-push hook runs them. git exports GIT_DIR to hooks, and an inherited
// GIT_DIR makes `git init`, `remote add`, `commit` and `push` act on THAT
// repository instead of the throwaway one. This runs the git-writing test
// in a child process with GIT_DIR (and friends) pointing at a throwaway
// "victim" repository and requires the victim's .git to stay byte-identical.
//
// Run from the repo root:  node --test scripts/tests/*.test.mjs

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanGitEnv } from "../../plugins/agent-companion/scripts/lib/git-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

// No auto-maintenance/gc: a recent git detaches `maintenance run --auto`
// after a commit, and its transient objects/maintenance.lock (or a repack)
// races hashTree() below. Seen on the Linux CI runner.
const NO_AUTO_MAINT = ["-c", "maintenance.auto=false", "-c", "gc.auto=0"];

function git(args, cwd) {
  const r = spawnSync("git", [...NO_AUTO_MAINT, ...args], { cwd, encoding: "utf8", windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function hashTree(dir, out = {}, base = dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { out[p.slice(base.length)] = "LINK"; continue; }
    if (st.isDirectory()) { hashTree(p, out, base); continue; }
    out[p.slice(base.length)] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return out;
}

function makeVictim() {
  const root = mkdtempSync(join(tmpdir(), "githermetic-"));
  temps.push(root);
  const repo = join(root, "victim");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main", repo]);
  git(["-C", repo, "config", "user.name", "fixture"]);
  git(["-C", repo, "config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(["-C", repo, "add", "-A"]);
  git(["-C", repo, "commit", "-q", "-m", "seed"]);
  return repo;
}

// The nested `node --test` must not think it is a worker of this run.
function childEnv(leak) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("NODE_TEST_")) env[k] = v;
  return { ...env, ...leak };
}

const LEAKS = [
  ["absolute GIT_DIR (native separators)", (repo) => ({ GIT_DIR: join(repo, ".git") })],
  ["absolute GIT_DIR (forward slashes) + GIT_WORK_TREE", (repo) => ({
    GIT_DIR: join(repo, ".git").replace(/\\/g, "/"), GIT_WORK_TREE: repo.replace(/\\/g, "/"),
  })],
];

for (const [label, leak] of LEAKS) {
  test(`leak-check-parity F1 (creates, commits and pushes repos) leaves a repo named by an inherited ${label} untouched`, () => {
    const repo = makeVictim();
    const before = hashTree(join(repo, ".git"));
    const r = spawnSync(process.execPath, [
      "--test", "--test-reporter=tap", "--test-name-pattern", "F1 parity",
      join(REPO_ROOT, "scripts", "tests", "leak-check-parity.test.mjs"),
    ], { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true, env: childEnv(leak(repo)), timeout: 120000 });
    assert.deepEqual(hashTree(join(repo, ".git")), before, "the victim's .git changed");
    assert.equal(r.status, 0, `F1 must still pass under the leaked env:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^# pass 1$/m, "exactly the F1 test ran");
  });
}
