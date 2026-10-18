// Parity + second-review regressions for the TWO copies of the generic leak
// classes: scripts/leak-check.mjs (zero-dependency, copied into other repos)
// and plugins/agent-companion/scripts/lib/leak-scan-core.mjs (the plugin's
// sweep engine). They are deliberately separate files kept in sync by hand
// (see both headers); this test feeds IDENTICAL inputs to both and requires
// identical outputs, so a fix landed in one copy only goes red here.
//
// Run from the repo root:  node --test scripts/tests/*.test.mjs
//
// SELF-SCAN RULE: this file is itself scanned by the whole-repo leak-check,
// so every leak-SHAPED fixture is assembled from pieces at run time. Every
// name is synthetic (zorbl, frobnicator, prefix bqq/zb, user qzhandle).

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as script from "../leak-check.mjs";
import * as core from "../../plugins/agent-companion/scripts/lib/leak-scan-core.mjs";
import { cleanGitEnv } from "../../plugins/agent-companion/scripts/lib/git-env.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "leak-check.mjs");
const BS = "\\";
const U = "Us" + "ers";
const COPIES = [["scripts/leak-check.mjs", script], ["leak-scan-core.mjs", core]];

const temps = [];
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), `lcparity-${prefix}-`));
  temps.push(d);
  return d;
}
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function world() {
  const dev = tmp("dev");
  for (const d of [
    "zorbl", "zorbl-internal", // H1: public root + private extension
    "frobnicator-api", "frobnicator-web", // cluster root "frobnicator" + joined forms
    "quimbly-tool", "quimbly-tool-some-branch", // worktree copy (collapse)
    "PlonkWizzleDraft", // camelCase initialism prefix
    "scripts", "tmp", "voice-tools",
  ]) mkdirSync(join(dev, d), { recursive: true });
  const agents = join(dev, "zorbl-internal", ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  for (const f of ["bqq-builder.md", "bqq-reviewer.md"]) writeFileSync(join(agents, f), "x");
  const projects = tmp("projects");
  mkdirSync(join(projects, ["C-", U, "qzhandle", "dev", "snorkelwhip"].join("-")), { recursive: true });
  return { dev, projects };
}

const CORPUS = [
  // H1 / H2
  "ported from zorbl-internal; zorbl itself is public",
  "the ZorblInternal client and FrobnicatorService class",
  "three Zorbls and a frobnicators list; zorblxyz",
  "see frobnicatorapi and frobnicatorweb and frobnicatorxyz",
  "QUIMBLY_TOOL and quimblytoolsomebranch",
  // H3
  "see {{Frobnicator}} and {{ZORBL_INTERNAL}} and {{BQQ_TOKEN}} and {{QZHANDLE}}",
  "a real placeholder {{PROJECT_NAME}} by {{OwnerName}}",
  // M1 — the reviewer's 13 cases
  ["D:", "dev", "bqq-tool"].join(BS),
  ["D:", "bqq-tool"].join(BS),
  `"${["D:", "dev", "bqq-x"].join(BS + BS)}"`,
  ["D:", "dev", "bqq-x"].join(BS + BS + BS + BS),
  ["CORP", "bqq-svc"].join(BS),
  "plain bqq-writer",
  `/${BS}bqq-/`,
  `(?:${BS}bqq-)`,
  `"${BS}${BS}bqq-"`,
  `[${BS}bqq-]`,
  `a|${BS}bqq-`,
  `"${BS}nbqq-"`,
  `${BS}${BS}bqq-host${BS}share`,
  // H4 / L3 paths
  ["C:", U, "Admin", "x"].join(BS),
  ["C:", U, "you", "x"].join(BS),
  ["%2Fhome%2F", "qzhandle", "%2Fdev"].join(""),
  ["%2Fhome%2F", "user", "%2Fdev"].join(""),
  "owner: qzhandle, and the admin user",
  ["~", ".claude", "projects", ["C-", U, "qzhandle", "dev", "snorkelwhip"].join("-")].join("/"),
  "We run 40 work" + "trees.",
];

function deriveBoth(opts) {
  return COPIES.map(([, m]) => m.deriveTokens(opts));
}

test("parity: deriveTokens gives identical output from identical inputs", () => {
  const { dev, projects } = world();
  const opts = { devRoots: [dev], claudeProjectsDir: projects, users: ["qzhandle", "Admin"], ownNames: ["agent-templates"], publicNames: ["zorbl"] };
  const [a, b] = deriveBoth(opts);
  assert.deepEqual(a, b);
  // and it is the H1-correct output, not just the same wrong one twice
  const names = a.names.map((n) => n.toLowerCase());
  assert.ok(names.includes("zorbl-internal") && !names.includes("zorbl"), JSON.stringify(a.names));
  assert.deepEqual(a.realUsers.sort(), ["admin", "qzhandle"]);
});

test("parity: compileDerived + scanText give identical hits on the whole corpus", () => {
  const { dev, projects } = world();
  const opts = { devRoots: [dev], claudeProjectsDir: projects, users: ["qzhandle", "Admin"], ownNames: ["agent-templates"], publicNames: ["zorbl"] };
  const [ta] = deriveBoth(opts);
  const realUsers = new Set(ta.realUsers);
  const text = CORPUS.join("\n");
  const [ra, rb] = COPIES.map(([, m]) => m.scanText(text, { rel: "c.md", derived: m.compileDerived(ta), realUsers, noSha: true }));
  assert.deepEqual(ra, rb);
  assert.ok(ra.hits.length > 10, "the corpus must actually exercise the matchers");
});

test("parity: decodeProjectDir, exactNameKey, isUnsafeDevRoot agree", () => {
  for (const e of [["C-", U, "qzhandle", "dev", "snorkelwhip--claude-worktrees-x"].join("-"), "-ho" + "me-qzhandle-code-plimsk", "C--WINDOWS-system32"]) {
    assert.deepEqual(script.decodeProjectDir(e), core.decodeProjectDir(e));
  }
  for (const s of ["Zorbl Internal", "zorbl_internal", "ZORBL-internal"]) assert.equal(script.exactNameKey(s), core.exactNameKey(s));
  for (const p of [tmpdir(), join(tmpdir(), "x"), process.platform === "win32" ? "Q:\\zb-projects" : "/opt/zb-projects"]) {
    assert.equal(script.isUnsafeDevRoot(p, "/nonexistent-home"), core.isUnsafeDevRoot(p, "/nonexistent-home"));
  }
});

// --- the same second-review regressions, asserted on BOTH copies ----------

const hitsOf = (m, text, tokens, extra = {}) => m.scanText(text, { rel: "x.md", derived: m.compileDerived(tokens), noSha: true, ...extra }).hits;

for (const [name, m] of COPIES) {
  test(`${name} H1: public "zorbl" does not take private "zorbl-internal" down with it`, () => {
    const dev = tmp("h1");
    for (const d of ["zorbl", "zorbl-internal"]) mkdirSync(join(dev, d));
    const t = m.deriveTokens({ devRoots: [dev], publicNames: ["zorbl"] });
    const hits = hitsOf(m, "zorbl-internal and zorbl", t).filter((h) => h.label === "derived-project-name");
    assert.deepEqual(hits.map((h) => h.token), ["zorbl-internal"]);
  });

  test(`${name} H2: ZorblApi / FrobnicatorService match, Zorbls does not, zorblapi only as a derived joined name`, () => {
    const tokens = { names: ["zorbl", "frobnicator"] };
    assert.equal(hitsOf(m, "ZorblApi", tokens).length, 1);
    assert.equal(hitsOf(m, "FrobnicatorService", tokens).length, 1);
    assert.equal(hitsOf(m, "Zorbls", tokens).length, 0);
    assert.equal(hitsOf(m, "zorblapi", tokens).length, 0, "not derived as a joined name here");
    assert.equal(hitsOf(m, "zorblapi", { ...tokens, joined: [["zorbl", "zorbl-api"]] }).length, 1);
    assert.equal(hitsOf(m, "zorblxyz", { ...tokens, joined: [["zorbl", "zorbl-api"]] }).length, 0);
  });

  test(`${name} H3: {{Frobnicator}} / {{ZORBL}} are not masked; {{PROJECT_NAME}} is`, () => {
    const tokens = { names: ["frobnicator", "zorbl"] };
    assert.equal(hitsOf(m, "{{Frobnicator}}", tokens).length, 1);
    assert.equal(hitsOf(m, "{{ZORBL}}", tokens).length, 1);
    assert.equal(hitsOf(m, "{{PROJECT_NAME}}", tokens).length, 0);
  });

  test(`${name} H4: generic-looking real handle fires in a profile path via realUsers, not as a bare word`, () => {
    const t = m.deriveTokens({ users: ["Admin"] });
    const line = ["C:", U, "Admin", "x"].join(BS) + " ask the admin";
    const hits = hitsOf(m, line, t, { realUsers: new Set(t.realUsers) });
    assert.deepEqual(hits.map((h) => h.label), ["private-path:windows-profile"]);
  });

  test(`${name} M1: backslash boundary only after a path segment or drive letter`, () => {
    const tokens = { prefixes: ["bqq"] };
    const caught = [["D:", "dev", "bqq-tool"].join(BS), ["D:", "bqq-tool"].join(BS), `"${["D:", "dev", "bqq-x"].join(BS + BS)}"`,
      ["D:", "dev", "bqq-x"].join(BS + BS + BS + BS), ["CORP", "bqq-svc"].join(BS), "plain bqq-writer"];
    const silent = [`/${BS}bqq-/`, `(?:${BS}bqq-)`, `"${BS}${BS}bqq-"`, `[${BS}bqq-]`, `a|${BS}bqq-`, `"${BS}nbqq-"`, `${BS}${BS}bqq-host${BS}share`];
    for (const l of caught) assert.equal(hitsOf(m, l, tokens).filter((h) => h.label === "derived-prefix").length, 1, l);
    for (const l of silent) assert.equal(hitsOf(m, l, tokens).filter((h) => h.label === "derived-prefix").length, 0, l);
  });

  test(`${name} L3: %2Fhome%2F<user> is a url-encoded private path`, () => {
    const hits = hitsOf(m, ["%2Fhome%2F", "qzhandle", "%2Fdev"].join(""), {});
    assert.ok(hits.some((h) => h.label === "private-path:url-encoded"));
  });
}

// --- CLI (scripts/leak-check.mjs only: the portable entry point) -----------

// cleanGitEnv: the CLI's own `git ls-files` must list the fixture root, not a
// repository named by an inherited GIT_DIR (see the F1 fixture below).
function runCli(root, args, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: cleanGitEnv(process.env, { LEAK_CHECK_DEV_ROOT: "", LEAK_CHECK_CLAUDE_PROJECTS: "", LEAK_CHECK_TOKEN_FILE: "", LEAK_CHECK_USER: "", ...env }),
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

test("CLI H4: --user Admin makes a C:\\Users\\Admin path a hit even with --no-derived; bare 'admin' is not", () => {
  const root = tmp("h4cli");
  writeFileSync(join(root, "a.md"), `open ${["C:", U, "Admin", "x"].join(BS)}\nask the admin\n`);
  const r = runCli(root, ["--no-derived", "--user", "Admin"]);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /private-path:windows-profile/);
  assert.doesNotMatch(r.err, /derived-user-handle/);
  const other = runCli(root, ["--no-derived", "--user", "qzhandle"]);
  assert.equal(other.code, 0, other.err);
});

test("CLI L3: a scan root directly under the temp dir never makes the temp dir a dev root", () => {
  const root = tmp("l3cli"); // sits directly under tmpdir()
  const fakeHome = tmp("home"); // also inside temp, so ~/dev is filtered too
  writeFileSync(join(root, "a.md"), "nothing\n");
  const r = runCli(root, ["--show-derived", "--claude-projects", join(root, "none"), "--user", "qzhandle"],
    { HOME: fakeHome, USERPROFILE: fakeHome });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /"devRootDirs":0/);
});

// --- final review F1: the plugin SWEEP path and the CLI agree ---------------
// Same fixture, same dev root / projects dir / user, same public-name list:
// the plugin's sweepRepo() (public names on the exact path) and
// scripts/leak-check.mjs (LEAK_CHECK_OWN_NAMES) must report the same hits.
// Regression: the sweep once put public names on the per-WORD ownNames
// path, so a public "acme-tools" silently exempted a private "acme".

test("F1 parity: plugin sweepRepo and scripts/leak-check.mjs agree with the same public-name list", async () => {
  const { sweepRepo, STRICT_MARKER_FILE } = await import("../../plugins/agent-companion/scripts/lib/publication-sweep.mjs");
  const dev = tmp("f1dev");
  for (const d of ["acme", "acme-alpha", "acme-beta", "zorbl-internal"]) mkdirSync(join(dev, d), { recursive: true });
  const projects = tmp("f1proj");
  const publicNames = ["myorg/acme-tools", "myorg", "acme-tools"];

  const base = tmp("f1repo");
  const bare = join(base, "origin.git");
  const work = join(base, "work");
  // cleanGitEnv, never a bare `...process.env`: this test runs from the
  // pre-push hook, where git exports GIT_DIR, and an inherited GIT_DIR makes
  // `git init <bare>`, `remote add`, `commit` and `push` act on THAT
  // repository instead of these throwaway ones.
  const gitEnv = cleanGitEnv(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x.invalid" });
  const git = (args, cwd) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: gitEnv });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git(["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  mkdirSync(work, { recursive: true });
  git(["init", "--quiet", "-b", "main"], work);
  git(["remote", "add", "origin", bare], work);
  writeFileSync(join(work, STRICT_MARKER_FILE), "");
  writeFileSync(join(work, "NOTES.md"), [
    "ported from acme last year",
    "the acme-gamma service",
    "see acme-tools and myorg/acme-tools on github",
    "zorbl-internal notes",
    `open ${["C:", U, "qzhandle", "dev", "x"].join(BS)}`,
    "",
  ].join("\n"));
  git(["add", "-A"], work);
  git(["commit", "--quiet", "-m", "x"], work);
  git(["push", "--quiet", "origin", "main"], work);

  const key = (h) => `${h.rel}:${h.line}:${h.label}:${String(h.token).toLowerCase()}`;
  const swept = await sweepRepo(bare, { devRoots: [dev], claudeProjectsDir: projects, users: ["qzhandle"], publicNames });
  assert.equal(swept.error, null, swept.error);
  const pluginKeys = [...new Set(swept.hits.map(key))].sort();

  const cli = runCli(work, [], {
    LEAK_CHECK_DEV_ROOT: dev, LEAK_CHECK_CLAUDE_PROJECTS: projects, LEAK_CHECK_USER: "qzhandle",
    LEAK_CHECK_OWN_NAMES: publicNames.join(","),
  });
  assert.equal(cli.code, 1, cli.err);
  const HIT = /^ {2}(\S.*?):(\d+) {2}\[([^\]]+)\] {2}(.*?) {2}:: {2}/;
  const cliKeys = [...new Set(cli.err.split(/\r?\n/).map((l) => HIT.exec(l)).filter(Boolean)
    .map(([, rel, line, label, token]) => key({ rel, line, label, token })))].sort();

  assert.deepEqual(pluginKeys, cliKeys);
  assert.ok(pluginKeys.some((k) => /derived-project-name:acme$/.test(k)), `private "acme" must fire: ${pluginKeys}`);
  // The exact public name is never itself a derived token (a private
  // "acme" inside it on line 3 still fires — in both copies).
  assert.ok(!pluginKeys.some((k) => /:acme-?tools$/.test(k)), `the exact public name must not be a token: ${pluginKeys}`);
});
