#!/usr/bin/env node
// leak-check.mjs — fails (exit 1) if any committable file contains a real-world
// token.
//
// This library is meant to be vendor-agnostic and project-agnostic. The seed
// material was genericized from real Claude Code agent teams, so this guard
// exists to make sure no real name, path, domain, or git SHA ever survives a
// contribution back into the library.
//
// FOUR CHECK CLASSES
//   1. Static tokens — a fixed literal list (below, hex-encoded) plus
//      git-SHA-like hex runs. Runs everywhere, including CI.
//   2. Derived names — the operator's REAL local project names, agent-file
//      prefixes and OS user handle, derived at RUN TIME from the machine
//      (see "Derived tokens" below). The derived list is never written
//      anywhere: it IS the private data. On a machine with no dev root (a
//      public CI runner) this class degrades to a note and finds nothing.
//   3. Private absolute paths — Windows user-profile paths, /home/<user>/,
//      /Users/<user>/, ~/dev/<project>, and path-encoded ~/.claude/projects
//      directory names that carry a real user. Placeholders are exempt.
//   4. WARNING only (exit code unaffected) — machine-structure detail such as
//      worktree counts or "N projects / N repos" scale statements.
// Anything inside {{...}} is exempt from every class (the placeholder
// convention).
//
// FILE SET: the guard scans the COMMITTABLE set — files git tracks plus
// untracked files that are NOT gitignored — via
// `git ls-files --cached --others --exclude-standard`. This honors .gitignore,
// so a gitignored file that holds real tokens BY DESIGN (e.g. the maintainer's
// populated PROVENANCE.local.md) does NOT trip the guard locally. That matches
// the guard's intent — it protects what could be committed — and matches CI,
// where gitignored files are simply absent on a fresh checkout. If git is
// unavailable (not a repo / no git on PATH), it falls back to walking the tree.
//
// Zero dependencies. Run from anywhere:
//   node scripts/leak-check.mjs [options]
//
// OPTIONS (each flag has an env-var equivalent; the flag wins)
//   --root <dir>             LEAK_CHECK_ROOT            tree to scan (default: this repo)
//   --dev-root <dir>[,<dir>] LEAK_CHECK_DEV_ROOT        dev root(s) whose child dirs are
//                                                       real project names (default: the
//                                                       main checkout's parent dir, plus
//                                                       ~/dev; the home dir itself is
//                                                       never used as a dev root)
//   --claude-projects <dir>  LEAK_CHECK_CLAUDE_PROJECTS path-encoded project dirs
//                                                       (default: ~/.claude/projects)
//   --token-file <file>      LEAK_CHECK_TOKEN_FILE      private extra tokens, one per line
//                                                       (# comments). Must live OUTSIDE the
//                                                       scanned tree. For CI/other machines:
//                                                       write it from a secret at run time.
//   --user <name>[,<name>]   LEAK_CHECK_USER            OS user handle(s) (default: derived
//                                                       from the OS)
//   --own-names <n>[,<n>]    LEAK_CHECK_OWN_NAMES       extra names EXEMPT from class 2 (never
//                                                       treated as a leak here) on top of this
//                                                       repo's own name/owner. A caller with a
//                                                       list of other PUBLIC names (e.g. the
//                                                       agent-companion sweep, which knows every
//                                                       repo it discovered as public) passes them
//                                                       here so a public name mentioned in this
//                                                       repo is never flagged as someone's real
//                                                       private project name. Default: only this
//                                                       repo's own name/owner is exempt, as before.
//   --no-derived             LEAK_CHECK_NO_DERIVED=1    skip class 2 entirely
//   --show-derived                                      print the derived token COUNTS by
//                                                       source (never the tokens) to stderr
//
// IMPORTANT DESIGN NOTE: the banned tokens below are assembled from hex byte
// sequences at runtime so that THIS source file does not itself contain any of
// the literal banned substrings (otherwise leak-check would flag itself). Do
// not paste the literal real-world strings into this file — add a new hex
// entry instead (see `fromHex`). Never add a derived (machine) name here
// either: derived names are discovered at run time precisely so that the list
// is never committed.
//
// RELATIONSHIP TO plugins/agent-companion/scripts/lib/leak-scan-core.mjs:
// that module is a DELIBERATELY SEPARATE, independently-maintained copy of
// this file's classes 2-4 (derived names, private paths, warnings) and the
// scan/enumerate machinery, owned by the public agent-companion plugin so it
// can scan a THIRD-PARTY repo's tree with no leak-check of its own (see that
// file's header). It is NOT imported here on purpose: this file's whole
// value — "copy scripts/leak-check.mjs into any repo and it just runs" — is
// zero-dependency portability, and the plugin's publication-leak sweep
// literally exercises that by copying just this one file into a throwaway
// repo (see leak-sweep-canary.mjs). An import back to the plugin would break
// that the moment this file is copied anywhere else. Keep the two in sync by
// hand when the generic classes change; this file's class 1 (the literal
// list above) and EXEMPT map stay here only — they are this repo's private
// data and must never appear in the public plugin.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, resolve, basename, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// Decode a space-separated hex byte string into UTF-8 text. Keeps the literal
// banned token out of this file's own source.
function fromHex(hex) {
  return Buffer.from(hex.replace(/\s+/g, ""), "hex").toString("utf8");
}

// --- Banned literal substrings (case-insensitive), stored as hex ------------
// Each entry: [label, hexBytes]. Decode -> lowercase compare against file text.
const LITERAL_TOKENS = [
  ["project-name-A",         "676f6f647374756666736f667477617265"],                       // the studio site slug
  ["project-name-A-spaced",  "476f6f6420537475666620536f667477617265"],                   // the studio name with spaces
  ["project-name-A-domain",  "676f6f647374756666736f6674776172652e636f6d"],               // its .com domain
  ["product-B",              "626573747375646f6b75"],                                      // the sudoku product slug
  ["product-B-spaced",       "42657374 2053 75646f6b75"],                                  // the sudoku product, spaced
  ["product-B-domain",       "626573747375646f6b752e617070"],                             // its .app domain
  ["user-home-path",         "433a5c55736572735c6d73616e74"],                             // C:\Users\<handle>
  ["user-handle",            "6d73616e74"],                                                // the OS handle
  ["full-name",              "4d69636861656c2053616e746f726f"],                           // founder full name
  ["surname",                "53616e746f726f"],                                            // founder surname
  ["legacy-branch",          "636c617564652f7375 646f6b752d7675 652d617070"],             // an old cowork branch name
  ["user-email",             "73616e746f72 6f3132 40676d61696c2e636f6d"],                 // personal gmail
  ["coord-bus-name",         "6465636b68616e64"],                                          // the shared agent-coordination-bus host
  ["workboard-name",         "776865656c686f757365"],                                      // the shared work-board/graph tool
];

const banned = LITERAL_TOKENS.map(([label, hex]) => ({
  label,
  needle: fromHex(hex).toLowerCase(),
}));

// --- Ownership exemption (narrow, file- AND token-scoped) -------------------
// A license file legally MUST name its copyright holder, so the LICENSE file
// is allowed to contain the studio's own name — that is ownership metadata,
// not a project-specifics leak. The exemption is deliberately tiny:
//   * keyed by exact relative path (only `LICENSE`),
//   * and by the single token label the LICENSE text actually uses.
// The standard MIT copyright line contains only the SPACED company name, so
// that is the ONLY label exempted — the no-space slug and the .com domain do
// NOT appear in LICENSE and are NOT exempted (if a future attribution line
// needs one, add it then, with the same "only what's used" discipline).
// Everything else stays banned EVEN in LICENSE: the product name, the personal
// name/handle/email, user-home paths, and git-SHA-like hex. And the company
// name stays banned in every OTHER file. If you find yourself wanting to widen
// this map, that's the signal to genericize instead.
// A published plugin manifest names its publisher for the same reason a LICENSE
// names its copyright holder: it is ownership metadata, and a plugin shipped
// from the studio's marketplace is attributed to the studio by definition. Same
// discipline as LICENSE — only the SPACED company name, only in the manifests
// that actually display it. The slug and the .com domain stay banned everywhere,
// as do the product name, personal name/handle/email, and user-home paths.
// Derived-name hits are NOT covered by this map (their labels differ), except
// where noted below.
const EXEMPT = {
  LICENSE: new Set([
    "project-name-A-spaced", // the studio name with spaces (used in the copyright line)
  ]),
  ".claude-plugin/marketplace.json": new Set([
    "project-name-A-spaced", // marketplace `owner.name`
  ]),
  "plugins/agent-companion/.claude-plugin/plugin.json": new Set([
    "project-name-A-spaced", // plugin `author.name`
  ]),
  // A repo's own install instructions must name the repo. `marketplace add
  // <owner>/<repo>` is this repository's public address — self-reference, not a
  // project-specifics leak, and a README that will not say where to install
  // from is useless. Only the no-space slug (which appears in the GitHub path)
  // is exempted, and only in these two files.
  //
  // NOTE: this is the second widening of this map. The guidance above says that
  // wanting to widen is the signal to genericize instead. It holds — if a third
  // file wants an exemption, stop and reconsider rather than adding a line here.
  "README.md": new Set([
    "project-name-A", // the owner segment of the marketplace install command
  ]),
  "plugins/agent-companion/README.md": new Set([
    "project-name-A", // same install command in the plugin's own README
  ]),
};

// --- Banned patterns (regex) ------------------------------------------------
// A bare git SHA: a standalone hex run 7-40 chars long. We require word
// boundaries and that the run is NOT inside a longer hex string (so it doesn't
// trip on, say, a CSS color or a base64 blob fragment that happens to be hex).
// Generic placeholder examples and {{TOKENS}} are fine — they aren't hex runs.
const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;

function isShaFalsePositive(match) {
  // All-digit runs (e.g. dates, ports, dimensions like 1200) are not SHAs.
  if (/^[0-9]+$/.test(match)) return true;
  // All-letter runs that are real words (e.g. "feedface" is borderline, but
  // common English hex-ish words) — be conservative: require at least one digit
  // OR length >= 12 to call it a SHA. Short all-letter hex (deed, cafe, face)
  // is almost always prose.
  if (/^[a-f]+$/i.test(match) && match.length < 12) return true;
  return false;
}

// A pinned GitHub Actions SHA (`uses: owner/action@<sha>`) is ownership
// metadata a workflow file is SUPPOSED to carry, not a leak.
function isPinnedActionSha(line, matchIndex) {
  const before = line.slice(0, matchIndex);
  if (!before.endsWith("@")) return false;
  return /uses:\s*[^\s@]+@$/.test(before);
}

// --- Class 3: private absolute paths ----------------------------------------
// A user-name segment is a PLACEHOLDER (exempt) when it is one of these generic
// words, or is visibly templated: <you>, {{USER}}, %USERNAME%, $USER, ${USER}.
const PLACEHOLDER_USERS = new Set([
  "you", "your", "yourname", "your-name", "your_name", "yourusername", "your-user",
  "user", "username", "user-name", "user_name", "users", "me", "name", "someone",
  "somebody", "example", "alice", "bob", "carol", "jdoe", "john", "jane", "janedoe",
  "johndoe", "dev", "developer", "runner", "public", "default", "all", "shared",
  "admin", "administrator", "guest", "operator", "maintainer", "x", "xxx", "foo",
  "bar", "me2", "home", "ubuntu", "vscode", "node", "root", "codespace", "codespaces",
  "linuxbrew", "runneradmin", "...", "…",
]);
// A project segment under ~/dev (or ~/code, ~/src, …) that is a placeholder.
const PLACEHOLDER_PROJECTS = new Set([
  "acme", "acme-app", "acme-web", "acme-api", "my-project", "myproject", "my-app",
  "myapp", "project", "projects", "your-project", "yourproject", "repo", "my-repo",
  "your-repo", "example", "example-project", "foo", "bar", "baz", "app", "demo",
  "sample", "x", "xyz", "project-name", "projectname", "name", "other-project",
  "some-project", "...", "…", "*",
]);

function isPlaceholderSegment(seg, set, realUsers) {
  if (!seg) return true;
  const s = seg.replace(/^["'`(]+|["'`),.;:]+$/g, "");
  if (!s) return true;
  if (realUsers && realUsers.has(s.toLowerCase())) return false; // a real handle is never a placeholder, even if generic-looking
  if (/^[<{%$[*]/.test(s)) return true; // <you>, {{USER}}, %USERNAME%, $USER, ${USER}, [user]
  return set.has(s.toLowerCase());
}

// Each entry: [label, regex, index of the capture group holding the segment
// that decides placeholder-vs-real, placeholder set].
// Separators cover forward slash, single/doubled/quadrupled backslash (a
// Windows path re-escaped through a second layer of JSON).
const SEP = String.raw`(?:\\\\\\\\|\\\\|\\|/)`;
const ESEP = String.raw`(?:%5[Cc]|%2[Ff])`;
const ECOLON = String.raw`(?::|%3[Aa])`;
const SEG = String.raw`([<{%$\[]?[A-Za-z0-9._\-…]+[>}%\]]?)`;
const PATH_PATTERNS = [
  // C:\Users\<name>\  C:/Users/<name>/  C:\\Users\\<name>  C:\\\\Users\\\\<name>
  ["private-path:windows-profile",
    new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:${SEP}Users${SEP}${SEG}`, "gi"), 1, PLACEHOLDER_USERS],
  // /home/<name>/ — no longer excluded when preceded by ':' (host:path forms).
  ["private-path:posix-home",
    new RegExp(String.raw`(?<![A-Za-z0-9._\-~])/home/${SEG}`, "g"), 1, PLACEHOLDER_USERS],
  // /Users/<name>/  (macOS)
  ["private-path:macos-home",
    new RegExp(String.raw`(?<![A-Za-z0-9._\-~])/Users/${SEG}`, "g"), 1, PLACEHOLDER_USERS],
  // WSL: /mnt/c/Users/<name>
  ["private-path:wsl-home",
    new RegExp(String.raw`/mnt/[a-z]/Users/${SEG}`, "gi"), 1, PLACEHOLDER_USERS],
  // ~/dev/<project>  ~/code/<project>  $HOME/dev/<project>  %USERPROFILE%\dev\<project>
  ["private-path:dev-project",
    new RegExp(String.raw`(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)${SEP}(?:dev|code|src|projects|repos|work|git)${SEP}${SEG}`, "gi"), 1, PLACEHOLDER_PROJECTS],
  // ~/.claude/projects/C--Users-<name>-…  or  -home-<name>-…  (path-encoded); case-insensitive.
  ["private-path:encoded-claude-project",
    new RegExp(String.raw`(?:(?<![A-Za-z0-9])[A-Za-z]--Users-|(?<![A-Za-z0-9])-(?:home|Users)-)([A-Za-z0-9_.]+)`, "gi"), 1, PLACEHOLDER_USERS],
  // UNC: \\host\c$\Users\<name>
  ["private-path:unc",
    new RegExp(String.raw`\\\\[A-Za-z0-9.\-]+\\[A-Za-z]\$\\Users\\${SEG}`, "gi"), 1, PLACEHOLDER_USERS],
  // URL-percent-encoded: C%3A%5CUsers%5C<name>, %2FUsers%2F<name>
  ["private-path:url-encoded",
    new RegExp(String.raw`(?:[A-Za-z]${ECOLON}${ESEP}Users${ESEP}|${ESEP}Users${ESEP})${SEG}`, "gi"), 1, PLACEHOLDER_USERS],
  // CORP\<user> — a Windows domain-qualified account name. Domain kept
  // ALL-CAPS to avoid matching ordinary "Word\word" prose. The segment
  // after `\` requires 2+ chars — a single letter there is far more often
  // a regex escape (\s \t \d \w \b \n \r) glued to more text.
  ["private-path:domain-user",
    new RegExp(String.raw`(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,14}\\([<{%$\[]?[A-Za-z0-9._\-…]{2,}[>}%\]]?)(?![A-Za-z0-9\\])`, "g"), 1, PLACEHOLDER_USERS],
];

// --- Class 4: machine-structure WARNINGS (never fail) -----------------------
// Conservative on purpose: only concrete counts of ten or more.
const WARN_PATTERNS = [
  ["machine-structure:count",
    /\b([1-9]\d+)\+?\s+(?:local\s+|active\s+|live\s+|git\s+|open\s+)?(worktrees?|projects|repos|repositories|directories|dirs|checkouts|clones|sessions)\b/gi],
];

// --- Class 2: derived tokens --------------------------------------------------
// Words that never become derived tokens on their own, and that make a
// multi-segment name "generic" when EVERY segment is one of them (such a name
// is indistinguishable from prose, e.g. two dictionary words).
const GENERIC_WORDS = new Set(`
a an and the for of to in on at by my our your new old next main master
dev devel development test tests testing tmp temp scratch spike poc sandbox
playground src source lib libs bin build dist out node modules vendor scripts
script docs doc notes misc stuff work workspace workspaces code repo repos
project projects example examples sample samples demo demos backup backups
archive archives copy fork forks clone mirror preview review reviews release
releases staging stage prod production beta alpha canary hotfix fix fixes
feature features branch merge final gate integration e2e ci cd ui ux cli api
app apps web site www server client service services data db config configs
tool tools util utils helper helpers common core shared local remote public
private home user users agent agents plugin plugins template templates skill
skills hook hooks memory claude git github gitlab image images voice audio video
isolation best report reports export exports import stats log logs cache
contrib product products page pages mobile desktop android ios windows linux
mac downloads documents pictures music videos appdata onedrive icloud dropbox
`.split(/\s+/).filter(Boolean));

// Names with any of these segments are scratch/temp dirs, not projects.
const TEMP_SEGMENTS = new Set(["tmp", "temp", "scratch", "bak", "backup", "old", "trash"]);

// Split a name into lowercase word segments: on - _ . space, and on camelCase.
function segmentsOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function cleanName(raw) {
  return raw.replace(/^[._]+/, "").trim();
}

// Is this candidate usable as a project NAME token?
function isUsableName(name, ownSegments) {
  const segs = segmentsOf(name);
  if (segs.length === 0) return false;
  const letters = segs.join("");
  if (letters.length < 4) return false; // too short to be distinctive
  if (/^[0-9a-f-]+$/i.test(name) && /\d/.test(name)) return false; // hex / uuid / numbers
  if (/^\d/.test(letters) && /^\d+$/.test(letters)) return false;
  if (segs.some((s) => TEMP_SEGMENTS.has(s))) return false;
  if (segs.every((s) => GENERIC_WORDS.has(s) || /^\d+$/.test(s))) return false;
  if (segs.length === 1 && ownSegments.has(segs[0])) return false;
  if (ownSegments.has("=" + segs.join(""))) return false; // the public repo / owner / plugin name itself
  return true;
}

// Is this candidate usable as a PREFIX token (matched only as `<prefix>-…`)?
function isUsablePrefix(p, ownSegments) {
  const s = p.toLowerCase();
  if (!/^[a-z][a-z0-9]{1,15}$/.test(s)) return false;
  if (GENERIC_WORDS.has(s) || TEMP_SEGMENTS.has(s) || ownSegments.has(s)) return false;
  return true;
}

function isUsableUser(u) {
  const s = (u || "").toLowerCase();
  if (s.length < 3) return false;
  if (PLACEHOLDER_USERS.has(s) || GENERIC_WORDS.has(s)) return false;
  return /^[a-z0-9._-]+$/.test(s);
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

// Decode one ~/.claude/projects entry (e.g. C--Users-<user>-dev-<project>, or
// -home-<user>-dev-<project>--claude-worktrees-<wt>) into { user, project }.
// The encoding is lossy (every : \ / . became -), so the project tail is only
// an approximation of the real directory name; that is fine for matching.
export function decodeProjectDir(entry, devBaseNames = ["dev"]) {
  let s = entry.replace(/--claude-worktrees-.*$/i, "").replace(/--claude$/i, "");
  const m = /(?:^|-)(?:home|users)-([^-]+)(?:-(.*))?$/i.exec(s);
  if (!m) return { user: null, project: null };
  const user = m[1];
  let rest = m[2] || "";
  if (!rest || rest.startsWith("-")) return { user, project: null }; // home itself / a dot-dir
  if (/^(appdata|temp|tmp|library|onedrive)(-|$)/i.test(rest)) return { user, project: null };
  const bases = [...new Set([...devBaseNames, "dev", "code", "src", "projects", "repos"].map((b) => b.toLowerCase()))];
  for (const b of bases) {
    if (rest.toLowerCase() === b) return { user, project: null };
    if (rest.toLowerCase().startsWith(b + "-")) {
      rest = rest.slice(b.length + 1);
      break;
    }
  }
  return { user, project: rest || null };
}

// Build the derived token set. Every input is injectable so tests never touch
// the real machine. Returns { names, prefixes, users, notes, counts }.
// EXACT normalization for public-name subtraction: lowercase, separators
// squashed away. Deliberately NOT segment-based — see deriveTokens()'s
// `publicNames` handling below for why.
export function exactNameKey(s) {
  return String(s || "").toLowerCase().replace(/[-_.\s]+/g, "");
}

export function deriveTokens({
  devRoots = [],
  claudeProjectsDir = null,
  tokenFile = null,
  users = [],
  ownNames = [],
  publicNames = [],
  scanRoot = null,
} = {}) {
  const notes = [];
  // Own (public) names: their word segments, plus each whole name squashed to
  // letters and keyed with a leading "=" so it cannot collide with a real segment.
  const ownSegments = new Set(ownNames.flatMap((n) => [...segmentsOf(n), "=" + segmentsOf(n).join("")]));
  const ownLower = new Set(ownNames.map((n) => n.toLowerCase()));
  const rawNames = new Map(); // lowercased -> original (first seen)
  const prefixCounts = new Map();
  const counts = { devRootDirs: 0, claudeProjects: 0, agentPrefixes: 0, clusterTokens: 0, tokenFile: 0, users: 0 };
  const usersOut = new Set();
  const explicit = new Set(); // token-file names: operator-curated, bypass the generic filter

  const addName = (raw) => {
    const n = cleanName(raw);
    if (!n || ownLower.has(n.toLowerCase())) return false;
    if (!rawNames.has(n.toLowerCase())) rawNames.set(n.toLowerCase(), n);
    return true;
  };

  // (a) child directories of each dev root, plus their agent-file prefixes
  const liveRoots = [];
  for (const root of devRoots) {
    const ents = safeReaddir(root);
    if (!ents) continue;
    liveRoots.push(root);
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (addName(e.name)) counts.devRootDirs++;
      const agentsDir = join(root, e.name, ".claude", "agents");
      const agents = safeReaddir(agentsDir);
      if (!agents) continue;
      const local = new Map();
      for (const a of agents) {
        if (!a.isFile() || !/\.md$/i.test(a.name)) continue;
        const m = /^([A-Za-z][A-Za-z0-9]*)-/.exec(a.name);
        if (m) local.set(m[1].toLowerCase(), (local.get(m[1].toLowerCase()) || 0) + 1);
      }
      for (const [p, c] of local) if (c >= 2) prefixCounts.set(p, (prefixCounts.get(p) || 0) + 1);
    }
  }
  if (devRoots.length && liveRoots.length === 0) {
    notes.push("no dev root found on this machine; project names are not derived from directories");
  }

  // (b) ~/.claude/projects path-encoded names
  if (claudeProjectsDir) {
    const ents = safeReaddir(claudeProjectsDir);
    if (!ents) {
      notes.push("no ~/.claude/projects directory found; its encoded project names are not derived");
    } else {
      const devBaseNames = liveRoots.map((r) => basename(r));
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const { user, project } = decodeProjectDir(e.name, devBaseNames);
        if (user && isUsableUser(user)) usersOut.add(user.toLowerCase());
        if (project && addName(project)) counts.claudeProjects++;
      }
    }
  }

  // (c) private token file (outside the scanned tree)
  if (tokenFile) {
    const abs = resolve(tokenFile);
    if (scanRoot && !relative(resolve(scanRoot), abs).startsWith("..") && !isAbsolute(relative(resolve(scanRoot), abs))) {
      throw new Error(`token file ${abs} is inside the scanned tree; keep it outside the repo`);
    }
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      throw new Error(`cannot read token file ${abs}: ${err.code || err.message}`);
    }
    for (const line of text.split(/\r?\n/)) {
      const t = line.replace(/#.*$/, "").trim();
      if (!t) continue;
      // `prefix:xyz` declares an agent-name prefix; anything else is a name.
      const pm = /^prefix:\s*(\S+)$/i.exec(t);
      if (pm) prefixCounts.set(pm[1].toLowerCase(), 99);
      else {
        rawNames.set(t.toLowerCase(), t);
        explicit.add(t.toLowerCase());
      }
      counts.tokenFile++;
    }
  }

  // (d) OS user handle(s)
  for (const u of users) if (isUsableUser(u)) usersOut.add(u.toLowerCase());
  counts.users = usersOut.size;

  // Filter to usable names.
  let names = [...rawNames.values()].filter((n) => explicit.has(n.toLowerCase()) || isUsableName(n, ownSegments));

  // (e) Cluster: a first segment shared by >= 2 derived names is itself a
  // token (e.g. two dirs "zork-api" and "zork-web" imply "zork"). Short shared
  // segments (2-4 chars) become prefixes rather than names. The names must
  // differ in their SECOND segment, so a project and its own worktree copies
  // ("zork-api", "zork-api-some-branch") do not promote "zork" by themselves.
  const firstSeg = new Map();
  for (const n of rawNames.values()) {
    const segs = segmentsOf(cleanName(n));
    if (segs.length < 2) continue;
    if (!firstSeg.has(segs[0])) firstSeg.set(segs[0], new Set());
    firstSeg.get(segs[0]).add(segs[1]);
  }
  for (const [seg, seconds] of firstSeg) {
    const c = seconds.size;
    if (c < 2 || GENERIC_WORDS.has(seg) || TEMP_SEGMENTS.has(seg) || ownSegments.has(seg) || ownSegments.has("=" + seg)) continue;
    if (seg.length >= 5 && isUsableName(seg, ownSegments)) {
      if (!names.some((n) => n.toLowerCase() === seg)) {
        names.push(seg);
        counts.clusterTokens++;
      }
    } else if (isUsablePrefix(seg, ownSegments) && !prefixCounts.has(seg)) {
      prefixCounts.set(seg, 1);
      counts.clusterTokens++;
    }
  }

  // Collapse: drop a name whose segments START WITH another kept name's
  // segments (worktree copies such as "<name>-<branch>"): the shorter name
  // already matches it on a word boundary.
  names.sort((a, b) => segmentsOf(a).length - segmentsOf(b).length || a.length - b.length);
  const kept = [];
  for (const n of names) {
    const segs = segmentsOf(n);
    const covered = kept.some((k) => {
      const ks = segmentsOf(k);
      return ks.length <= segs.length && ks.every((s, i) => s === segs[i]);
    });
    if (!covered) kept.push(n);
  }

  // (f) Initialisms of single-token camelCase names with 3+ words become
  // prefixes (e.g. a dir "AlphaBetaGamma" -> "abg-"), mirroring how agent-file
  // prefixes are formed. Hyphenated names are skipped: their initialisms are
  // mostly accidental and collide with real acronyms.
  for (const n of kept) {
    if (/[-_.\s]/.test(n)) continue;
    const segs = segmentsOf(n);
    if (segs.length < 3 || segs.length > 5) continue;
    const ini = segs.map((s) => s[0]).join("");
    if (isUsablePrefix(ini, ownSegments) && !prefixCounts.has(ini)) prefixCounts.set(ini, 1);
  }

  const prefixes = [...prefixCounts.keys()].filter((p) => prefixCounts.get(p) >= 99 || isUsablePrefix(p, ownSegments));
  counts.agentPrefixes = prefixes.length;

  // EXACT-only public-name subtraction (never segment-based, never applied
  // to prefixes — a private prefix that merely shares a segment with a
  // public name must stay flagged).
  const exactPublic = new Set(publicNames.map(exactNameKey));
  const namesOut = exactPublic.size ? kept.filter((n) => !exactPublic.has(exactNameKey(n))) : kept;

  return { names: namesOut, prefixes, users: [...usersOut], notes, counts };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compile derived tokens into matchers. Word boundary = not a letter/digit on
// either side. A preceding BACKSLASH IS a boundary (it's a path separator,
// not a word character) — excluding it would silently miss every derived
// name after one (D:\dev\<project>\x). Trailing boundary blocks a following
// lowercase letter/digit (no match inside a longer lowercase word) but not
// an uppercase one, so a camelCase continuation (ZorblApi) still counts.
// Multi-segment names tolerate any of - _ . or nothing between segments
// (and a space too, unless every segment is a dictionary word).
const LEAD = "(?<![A-Za-z0-9])";
const TRAIL = "(?![a-z0-9])";
export function compileDerived({ names = [], prefixes = [], users = [] }) {
  const out = [];
  for (const n of names) {
    const segs = segmentsOf(n);
    const allowSpace = !segs.every((s) => GENERIC_WORDS.has(s));
    const sepRe = allowSpace ? "[-_. ]?" : "[-_.]?";
    const body = segs.map(escapeRe).join(sepRe);
    out.push({ label: "derived-project-name", re: new RegExp(`${LEAD}${body}${TRAIL}`, "gi") });
  }
  for (const p of prefixes) {
    // No lookahead requiring more identifier chars to follow — a bare
    // `zb-`/`ZB_` (quoted, backticked, or at end of line) must still match.
    out.push({ label: "derived-prefix", re: new RegExp(`${LEAD}${escapeRe(p)}[-_]`, "gi") });
  }
  for (const u of users) {
    out.push({ label: "derived-user-handle", re: new RegExp(`${LEAD}${escapeRe(u)}${TRAIL}`, "gi") });
  }
  return out;
}

// Blank out every {{...}} span (same length, so columns stay stable) — but
// ONLY a genuine placeholder identifier (UPPER_SNAKE or a TitleCase Word):
// must start uppercase, letters/digits/underscore/hyphen only after that. A
// braced Windows profile path, or a braced REAL lowercase derived name,
// must still be scanned — wrapping a real leak in braces is not a way to
// hide it (this comment avoids writing that shape literally, since this
// file is itself scanned).
function maskPlaceholders(line) {
  return line.replace(/\{\{[A-Z][A-Za-z0-9_-]*\}\}/g, (m) => " ".repeat(m.length));
}

// Scan one file's text. Returns { hits, warnings }.
// `realUsers`: the operator's ACTUAL OS handle(s) (lowercased) — overrides
// PLACEHOLDER_USERS for the path classes only, so a real handle that
// happens to look generic ("admin") is still caught in a private path.
export function scanText(text, { rel = "", derived = [], isSelf = false, realUsers, noSha = false } = {}) {
  const hits = [];
  const warnings = [];
  const lines = text.split(/\r?\n/);
  const exempt = EXEMPT[rel];
  lines.forEach((rawLine, i) => {
    const line = maskPlaceholders(rawLine);
    const lower = line.toLowerCase();
    const push = (arr, label, token) => arr.push({ rel, line: i + 1, label, token, text: rawLine.trim() });

    for (const { label, needle } of banned) {
      // Skip a token only when THIS file is explicitly allowed to carry THIS
      // label (see EXEMPT above) — e.g. the company name in LICENSE.
      if (exempt?.has(label)) continue;
      let idx = lower.indexOf(needle);
      while (idx !== -1) {
        push(hits, label, line.slice(idx, idx + needle.length));
        idx = lower.indexOf(needle, idx + needle.length);
      }
    }

    if (!isSelf && !noSha) {
      for (const m of line.matchAll(SHA_RE)) {
        if (isShaFalsePositive(m[0])) continue;
        if (isPinnedActionSha(line, m.index)) continue;
        push(hits, "git-sha-like", m[0]);
      }
    }

    for (const { label, re } of derived) {
      for (const m of line.matchAll(re)) push(hits, label, m[0]);
    }

    for (const [label, re, group, set] of PATH_PATTERNS) {
      for (const m of line.matchAll(re)) {
        if (isPlaceholderSegment(m[group], set, realUsers)) continue;
        push(hits, label, m[0]);
      }
    }

    for (const [label, re] of WARN_PATTERNS) {
      for (const m of line.matchAll(re)) push(warnings, label, m[0]);
    }
  });
  return { hits, warnings };
}

// --- Files we scan ----------------------------------------------------------
const IGNORE_DIRS = new Set([".git", "node_modules"]);
// Heuristic: skip obvious binaries by extension.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|mp4|mov)$/i;
// SHA-ONLY skip: a minified bundle, a lockfile, or anything under
// node_modules/ is never going to carry a real leak worth reporting AS A
// HASH. Every OTHER class (path, handle, token-file, derived-name) still
// scans these files fully — including build/, dist/, vendor/ and
// sourcemaps, a classic absolute-path leak vector that must never be
// skipped wholesale.
const SHA_SKIP_PATH_RE = /(^|\/)node_modules\//i;
const SHA_SKIP_FILE_RE = /\.min\.(js|css)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/i;

// Fallback enumerator (used only if git is unavailable): walk the working tree,
// skipping .git and node_modules. This does NOT honor the rest of .gitignore, so
// it is strictly a degraded mode — see listCommittableFiles.
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

// Primary enumerator: the committable set — everything git tracks plus untracked
// files that are NOT gitignored. `--cached` = tracked, `--others` = untracked,
// `--exclude-standard` applies .gitignore / .git/info/exclude / global excludes.
// This is exactly "what could be committed," which is what the guard protects.
// Falls back to walk(root) if git is missing or this isn't a git repo (or the
// root is not the top of its repo, so a temp-dir fixture is walked, not the
// enclosing repo).
function listCommittableFiles(root) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (resolve(top).toLowerCase() !== resolve(root).toLowerCase()) throw new Error("scan root is not a git top-level");
    const out = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((rel) => join(root, rel));
  } catch (err) {
    console.error(
      `leak-check: note — git enumeration failed (${err.message.split("\n")[0]}); ` +
        "falling back to a raw working-tree walk that does NOT honor .gitignore.",
    );
    return walk(root);
  }
}

// The main checkout's directory (a linked worktree resolves to the repo it
// belongs to), so the default dev root is where the operator keeps projects.
function mainCheckoutDir(root) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirname(resolve(common));
  } catch {
    return resolve(root);
  }
}

function ownRepoNames(root) {
  const names = new Set([basename(mainCheckoutDir(root))]);
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // <owner>/<repo>: both are this repo's PUBLIC address, not private data.
    const m = /([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/.exec(url);
    if (m) {
      names.add(m[1]);
      names.add(m[2]);
    }
  } catch { /* no remote */ }
  // Plugins published from this repo are public names too.
  for (const e of safeReaddir(join(root, "plugins")) || []) if (e.isDirectory()) names.add(e.name);
  return [...names];
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--root") opts.root = val();
    else if (a === "--dev-root") opts.devRoot = val();
    else if (a === "--claude-projects") opts.claudeProjects = val();
    else if (a === "--token-file") opts.tokenFile = val();
    else if (a === "--user") opts.user = val();
    else if (a === "--own-names") opts.ownNames = val();
    else if (a === "--no-derived") opts.noDerived = true;
    else if (a === "--show-derived") opts.showDerived = true;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

const splitList = (v) => (v ? String(v).split(/[,;]/).map((s) => s.trim()).filter(Boolean) : []);

export function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`leak-check: ${err.message}`);
    return 2;
  }
  const root = resolve(opts.root || env.LEAK_CHECK_ROOT || REPO_ROOT);
  const noDerived = opts.noDerived || env.LEAK_CHECK_NO_DERIVED === "1";

  let derived = [];
  let realUsersList = [];
  if (noDerived) {
    console.error("leak-check: note — derived-name checks disabled (--no-derived).");
  } else {
    const home = resolve(homedir());
    let devRoots = splitList(opts.devRoot || env.LEAK_CHECK_DEV_ROOT).map((p) => resolve(p));
    if (devRoots.length === 0) {
      devRoots = [...new Set([dirname(mainCheckoutDir(root)), join(home, "dev")].map((p) => resolve(p)))]
        .filter((p) => p.toLowerCase() !== home.toLowerCase());
    }
    const claudeProjectsDir = resolve(opts.claudeProjects || env.LEAK_CHECK_CLAUDE_PROJECTS || join(home, ".claude", "projects"));
    const tokenFile = opts.tokenFile || env.LEAK_CHECK_TOKEN_FILE || null;
    let users = splitList(opts.user || env.LEAK_CHECK_USER);
    if (users.length === 0) {
      try { users.push(userInfo().username); } catch { /* no passwd entry */ }
      users.push(basename(home));
    }
    // --own-names / LEAK_CHECK_OWN_NAMES: EXACT-only public-name subtraction
    // (never segment-based — see deriveTokens()'s `publicNames` handling).
    // This repo's OWN name/owner (ownRepoNames) stays on the separate,
    // segment-based `ownNames` self-exemption, unaffected by this list.
    const publicNames = splitList(opts.ownNames || env.LEAK_CHECK_OWN_NAMES);
    const ownNames = ownRepoNames(root);
    let tokens;
    try {
      tokens = deriveTokens({ devRoots, claudeProjectsDir, tokenFile, users, ownNames, publicNames, scanRoot: root });
    } catch (err) {
      console.error(`leak-check: ${err.message}`);
      return 2;
    }
    for (const n of tokens.notes) console.error(`leak-check: note — ${n}.`);
    const total = tokens.names.length + tokens.prefixes.length + tokens.users.length;
    if (total === 0) {
      console.error("leak-check: note — no derived names on this machine; derived-name checks found nothing to match (static checks still run).");
    }
    if (opts.showDerived) {
      console.error(
        `leak-check: derived ${tokens.names.length} name(s), ${tokens.prefixes.length} prefix(es), ` +
          `${tokens.users.length} user handle(s) — sources: ${JSON.stringify(tokens.counts)}`,
      );
    }
    derived = compileDerived(tokens);
    realUsersList = tokens.users;
  }

  const realUsers = new Set(realUsersList);
  const selfAbs = resolve(fileURLToPath(import.meta.url));
  const hits = [];
  const warnings = [];
  for (const file of listCommittableFiles(root)) {
    if (BINARY_EXT.test(file)) continue;
    // EXEMPT keys are written with forward slashes; normalize or the exemption
    // silently never matches on Windows.
    const rel = relative(root, file).split(sep).join("/");
    const noSha = SHA_SKIP_PATH_RE.test(rel) || SHA_SKIP_FILE_RE.test(rel);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable / binary
    }
    const r = scanText(text, { rel, derived, isSelf: resolve(file) === selfAbs, realUsers, noSha });
    hits.push(...r.hits);
    warnings.push(...r.warnings);
  }

  if (warnings.length) {
    console.error(`leak-check: WARNING — ${warnings.length} machine-structure mention(s) (not a failure; review):`);
    for (const w of warnings) console.error(`  ${w.rel}:${w.line}  [${w.label}]  ${w.token}`);
    console.error("");
  }

  if (hits.length === 0) {
    console.log("leak-check: OK — no real-world tokens found.");
    return 0;
  }

  console.error(`leak-check: FAILED — ${hits.length} hit(s):\n`);
  for (const h of hits) {
    console.error(`  ${h.rel}:${h.line}  [${h.label}]  ${h.token}  ::  ${h.text}`);
  }
  console.error(
    "\nGenericize these before committing (real specifics -> {{PLACEHOLDERS}} or generic examples like acme.com).",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
