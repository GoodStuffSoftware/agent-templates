// Tests for scripts/leak-check.mjs (zero dependencies, node:test).
//
// Run from the repo root:  node --test scripts/tests/*.test.mjs
//
// HARD RULE: no test depends on the real machine. Every derived-token source
// (dev root, ~/.claude/projects, user handle, token file) is injected — either
// as a parameter to deriveTokens() or as a CLI flag pointing into a fresh temp
// dir — and every fixture name is SYNTHETIC (nonsense words that cannot be a
// real operator's project).
//
// SELF-SCAN RULE: this file is itself scanned by the whole-repo leak-check, so
// every fixture string that is SHAPED like a leak (an absolute profile path, an
// encoded projects dir, a count statement) is assembled at run time from
// pieces, and the file's source never contains the contiguous leak shape.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deriveTokens, compileDerived, scanText, decodeProjectDir } from "../leak-check.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "leak-check.mjs");

// --- run-time assembled leak shapes (never contiguous in this source) -------
const BS = "\\";
const U = "Us" + "ers";
const FAKE_USER = "quux" + "zorbuser";
const winBack = ["C:", U, FAKE_USER, "dev", "thing"].join(BS);
const winFwd = ["C:", U, FAKE_USER, "dev"].join("/");
const winEsc = ["D:", U, FAKE_USER, "x"].join(BS + BS);
const posixHome = "/ho" + "me/" + FAKE_USER + "/src";
const macHome = "/" + U + "/" + FAKE_USER + "/Library";
const devProject = "~" + "/dev/" + "snorfblat";
const encoded = "C-" + "-" + U + "-" + FAKE_USER + "-dev-snorfblat";

const temps = [];
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), `leakcheck-${prefix}-`));
  temps.push(d);
  return d;
}
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// A synthetic machine: a dev root with real-looking projects, a worktree copy,
// generic/temp dirs, the public repo's own name, agent files with a shared
// prefix, and a ~/.claude/projects dir with a path-encoded entry.
function fakeWorld() {
  const dev = tmp("dev");
  for (const d of [
    "zorvex-quill",
    "zorvex-quill-feature-branch", // worktree copy: collapses into zorvex-quill
    "FrobnicatePlumbusKit", // camelCase: initialism prefix "fpk-"
    "blarnwick",
    "grelk-api", // with grelk-web: cluster prefix "grelk"? (5 chars -> name)
    "grelk-web",
    "scripts", // generic
    "tmp", // generic
    "voice-tools", // every segment generic
    "_scratch-thing", // temp segment
    "agent-templates", // the public repo's own name
    ".hidden",
  ]) mkdirSync(join(dev, d), { recursive: true });
  const agents = join(dev, "blarnwick", ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  for (const f of ["zqx-builder.md", "zqx-reviewer.md", "doc-agent.md"]) writeFileSync(join(agents, f), "x");
  writeFileSync(join(dev, "loose-file.txt"), "x"); // files are not project names

  const projects = tmp("projects");
  for (const d of [
    encoded + "--claude-worktrees-happy-otter-abc123",
    "C-" + "-" + U + "-" + FAKE_USER, // the home dir itself
    "C-" + "-" + U + "-" + FAKE_USER + "-AppData-Local-Temp-claude-x", // temp: skipped
  ]) mkdirSync(join(projects, d), { recursive: true });
  return { dev, projects };
}

const OWN = ["agent-templates", "agent-companion"];

test("decodeProjectDir strips the encoded home, dev root and worktree suffix", () => {
  assert.deepEqual(decodeProjectDir(encoded + "--claude-worktrees-x-1"), { user: FAKE_USER, project: "snorfblat" });
  assert.deepEqual(decodeProjectDir("-ho" + "me-" + FAKE_USER + "-dev-plimsk"), { user: FAKE_USER, project: "plimsk" });
  assert.equal(decodeProjectDir("C-" + "-" + U + "-" + FAKE_USER + "--claude").project, null);
  assert.equal(decodeProjectDir("C-" + "-WINDOWS-system32").project, null);
});

test("deriveTokens derives names, prefixes and users from injected sources only", () => {
  const { dev, projects } = fakeWorld();
  const t = deriveTokens({ devRoots: [dev], claudeProjectsDir: projects, users: [FAKE_USER, "runner"], ownNames: OWN });
  const names = t.names.map((n) => n.toLowerCase()).sort();
  assert.deepEqual(names, ["blarnwick", "frobnicateplumbuskit", "grelk", "snorfblat", "zorvex-quill"]);
  assert.ok(t.prefixes.includes("zqx"), "agent-file prefix shared by 2+ files");
  assert.ok(t.prefixes.includes("fpk"), "camelCase initialism prefix");
  assert.ok(!t.prefixes.includes("doc"), "a prefix used by only one agent file is ignored");
  assert.deepEqual(t.users, [FAKE_USER], "generic handles like runner are stoplisted");
});

test("deriveTokens degrades gracefully when no dev root / projects dir exists", () => {
  const missing = join(tmp("none"), "does-not-exist");
  const t = deriveTokens({ devRoots: [missing], claudeProjectsDir: missing, users: ["runner"], ownNames: OWN });
  assert.equal(t.names.length + t.prefixes.length + t.users.length, 0);
  assert.equal(t.notes.length, 2);
});

function scanWith(text, tokens) {
  return scanText(text, { rel: "fixture.md", derived: compileDerived(tokens) });
}
const TOKENS = { names: ["zorvex-quill", "FrobnicatePlumbusKit"], prefixes: ["zqx", "bqz"], users: [FAKE_USER] };

test("placeholdered and generic text passes", () => {
  const ok = [
    "Clone into C:" + BS + U + BS + "<you>" + BS + "dev" + BS + "acme and run it.",
    "Or C:" + BS + U + BS + "you" + BS + "dev" + BS + "acme, or C:/" + U + "/%USERNAME%/dev.",
    "On Linux: /ho" + "me/user/dev/acme; on macOS /" + U + "/you/dev; or $HOME/.claude.",
    "Memory lives at ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md.",
    "The project is {{PROJECT_NAME}} and its agents are {{PREFIX}}-builder, {{zorvex-quill}}.",
    "See ~" + "/dev/acme or ~" + "/dev/<project> or ~" + "/dev/{{PROJECT}}.",
    "A zorvex-quillion is not the project, nor is prezorvex-quill; `\\bqz-ant` is a regex escape.",
    "Three worktrees and 4 projects is not a scale statement.",
    "The runner user and the admin user are generic.",
  ].join("\n");
  const r = scanWith(ok, TOKENS);
  assert.deepEqual(r.hits, []);
  assert.deepEqual(r.warnings, []);
});

const LEAKS = [
  ["derived-project-name", "we ported this from zorvex-quill last week"],
  ["derived-project-name", "the Zorvex Quill app"],
  ["derived-project-name", "see ZORVEX_QUILL/README"],
  ["derived-project-name", "from frobnicate-plumbus-kit too"],
  ["derived-prefix", "the zqx-builder agent"],
  ["derived-prefix", "files named `zqx-*.md`"],
  ["derived-user-handle", "owner: " + FAKE_USER],
  ["private-path:windows-profile", "open " + winBack],
  ["private-path:windows-profile", "open " + winFwd],
  ["private-path:windows-profile", '"cwd": "' + winEsc + '"'],
  ["private-path:posix-home", "cd " + posixHome],
  ["private-path:macos-home", "cd " + macHome],
  ["private-path:dev-project", "cd " + devProject],
  ["private-path:encoded-claude-project", "~/.claude/projects/" + encoded + "/memory"],
];

for (const [label, line] of LEAKS) {
  test(`leak class ${label} fails: ${JSON.stringify(line).slice(0, 60)}`, () => {
    const r = scanWith(line, { names: ["zorvex-quill", "frobnicate-plumbus-kit"], prefixes: ["zqx"], users: [FAKE_USER] });
    assert.ok(r.hits.some((h) => h.label === label), `expected ${label}, got ${JSON.stringify(r.hits)}`);
  });
}

test("path classes fire without any derived tokens (static, runs in CI)", () => {
  for (const line of [winBack, winFwd, winEsc, posixHome, macHome, devProject, encoded]) {
    const r = scanText(line, { rel: "fixture.md", derived: [] });
    assert.ok(r.hits.length > 0, `expected a path hit for ${line}`);
  }
});

test("machine-structure statements warn but never fail", () => {
  const r = scanWith("This machine has 87 work" + "trees across 23 local " + "repos.", TOKENS);
  assert.deepEqual(r.hits, []);
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.every((w) => w.label === "machine-structure:count"));
});

// --- CLI end-to-end -----------------------------------------------------------
function runCli(scanRoot, extraArgs = [], env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, "--root", scanRoot, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, LEAK_CHECK_DEV_ROOT: "", LEAK_CHECK_CLAUDE_PROJECTS: "", LEAK_CHECK_TOKEN_FILE: "", LEAK_CHECK_USER: "", ...env },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function scanTree(files) {
  const root = tmp("scan");
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test("CLI: clean tree exits 0; derived leak exits 1 with file:line", () => {
  const { dev, projects } = fakeWorld();
  const args = ["--dev-root", dev, "--claude-projects", projects, "--user", FAKE_USER];
  const clean = runCli(scanTree({ "a.md": "All generic: {{PROJECT}} at C:" + BS + U + BS + "<you>.\n" }), args);
  assert.equal(clean.code, 0, clean.err);
  const leaky = runCli(scanTree({ "a.md": "line one\nported from snorfblat and zorvex-quill\n" }), args);
  assert.equal(leaky.code, 1);
  assert.match(leaky.err, /a\.md:2\s+\[derived-project-name\]\s+snorfblat/);
  assert.match(leaky.err, /a\.md:2\s+\[derived-project-name\]\s+zorvex-quill/);
});

test("CLI: warnings print but exit 0", () => {
  const { dev, projects } = fakeWorld();
  const r = runCli(scanTree({ "a.md": "We run 40 work" + "trees.\n" }), ["--dev-root", dev, "--claude-projects", projects, "--user", FAKE_USER]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /WARNING/);
});

test("CLI: no dev root on this machine -> note, static checks still run", () => {
  const missing = join(tmp("none"), "nope");
  const args = ["--dev-root", missing, "--claude-projects", missing, "--user", "runner"];
  const clean = runCli(scanTree({ "a.md": "zorvex-quill is unknown here\n" }), args);
  assert.equal(clean.code, 0, clean.err);
  assert.match(clean.err, /no dev root found/);
  const leaky = runCli(scanTree({ "a.md": "cd " + posixHome + "\n" }), args);
  assert.equal(leaky.code, 1);
});

test("CLI: private token file adds names and prefixes; refused inside the scan root", () => {
  const missing = join(tmp("none"), "nope");
  const base = ["--dev-root", missing, "--claude-projects", missing, "--user", "runner"];
  const tokDir = tmp("tokens");
  const tokFile = join(tokDir, "tokens.txt");
  writeFileSync(tokFile, "# private tokens\nplimskador\nprefix: wqv\n");
  const r = runCli(scanTree({ "a.md": "plimskador and wqv-builder\n" }), [...base, "--token-file", tokFile]);
  assert.equal(r.code, 1);
  assert.match(r.err, /\[derived-project-name\]\s+plimskador/);
  assert.match(r.err, /\[derived-prefix\]\s+wqv-/);

  const root = scanTree({ "a.md": "nothing\n" });
  const inside = join(root, "tokens.txt");
  writeFileSync(inside, "plimskador\n");
  const refused = runCli(root, [...base, "--token-file", inside]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /inside the scanned tree/);
});

test("CLI: --no-derived skips derivation but keeps path checks", () => {
  const r = runCli(scanTree({ "a.md": "zorvex-quill\n" + "cd " + macHome + "\n" }), ["--no-derived"]);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /derived-project-name/);
  assert.match(r.err, /private-path:macos-home/);
});

test("CLI: --own-names exempts a PUBLIC sibling name (not a leak) but a different derived name still fires", () => {
  const { dev, projects } = fakeWorld();
  const args = ["--dev-root", dev, "--claude-projects", projects, "--user", FAKE_USER];
  // "snorfblat" and "zorvex-quill" are both real derived names in this fixture
  // world (see fakeWorld()/TOKENS below). --own-names marks "snorfblat" as a
  // known-PUBLIC name (e.g. a sibling repo discovery already confirmed) —
  // it must stop firing, while "zorvex-quill" (not in --own-names) still does.
  const r = runCli(
    scanTree({ "a.md": "mentions snorfblat and also zorvex-quill\n" }),
    [...args, "--own-names", "snorfblat"],
  );
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /\[derived-project-name\]\s+snorfblat/, "a --own-names entry must not fire as a leak");
  assert.match(r.err, /\[derived-project-name\]\s+zorvex-quill/, "an unrelated derived name must still fire");
});

test("CLI: LEAK_CHECK_OWN_NAMES env does the same as --own-names", () => {
  const { dev, projects } = fakeWorld();
  const args = ["--dev-root", dev, "--claude-projects", projects, "--user", FAKE_USER];
  const r = runCli(scanTree({ "a.md": "snorfblat only\n" }), args, { LEAK_CHECK_OWN_NAMES: "snorfblat" });
  assert.equal(r.code, 0, r.err);
});

test("CLI: vendor/minified/lockfile paths are skipped for every class, including git-sha-like", () => {
  const missing = join(tmp("none"), "nope");
  const args = ["--dev-root", missing, "--claude-projects", missing, "--user", "runner"];
  // 40 hex chars, assembled from 2-char pieces so no contiguous hex run of
  // 7+ chars ever appears literally in THIS file's own source (this file is
  // itself scanned by the whole-repo leak-check — see the header note).
  const leakyHex = ["01", "23", "45", "67", "89", "ab", "cd", "ef", "01", "23", "45", "67", "89", "ab", "cd", "ef", "01", "23", "45", "67"].join("");
  const r = runCli(scanTree({
    "vendor/lib.js": `const h = "${leakyHex}";\n`,
    "node_modules/pkg/index.js": `const h = "${leakyHex}";\n`,
    "dist/bundle.min.js": `const h = "${leakyHex}";\n`,
    "package-lock.json": `{"h": "${leakyHex}"}\n`,
    "src/real.js": `const h = "${leakyHex}";\n`,
  }), args);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /src\/real\.js/, "a normal source file must still be scanned");
  assert.doesNotMatch(r.err, /vendor\/lib\.js/);
  assert.doesNotMatch(r.err, /node_modules\/pkg\/index\.js/);
  assert.doesNotMatch(r.err, /dist\/bundle\.min\.js/);
  assert.doesNotMatch(r.err, /package-lock\.json/);
});
