#!/usr/bin/env node
// compose.mjs — profile-matched lesson composition, index generation, and
// fan-out detection for the lessons/ library. Zero dependencies (like
// leak-check.mjs); parses the small frontmatter subset by hand — no YAML lib.
//
// Usage:
//   node scripts/compose.mjs --index
//       Regenerate lessons/INDEX.md from every lesson's frontmatter.
//
//   node scripts/compose.mjs --profile <path-to-.template.lock>
//       Print (stdout) a "Lessons in effect" markdown section: all ACTIVE
//       lessons matching the lock's profile, grouped by axis, most-specific
//       first. Excludes deprecated/superseded.
//
//   node scripts/compose.mjs --profile <path> --since <libraryCommit>
//       As above, AND list lessons added/changed since <libraryCommit> that
//       match the profile (the fan-out / "re-hydration available" signal).
//
// Every invocation validates frontmatter (unknown axis prefix, missing
// id/title/scope/status, duplicate ids) and exits nonzero with file:line on
// any problem.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LESSONS_DIR = join(ROOT, "lessons");
const INDEX_PATH = join(LESSONS_DIR, "INDEX.md");

// Axis specificity, most-specific first. `project` is conceptual only (never in
// the library) but listed so cascade ordering is documented in one place.
const AXIS_ORDER = [
  "project",
  "archetype",
  "stack",
  "env",
  "vendor",
  "agent-process",
  "universal",
];
const KNOWN_AXES = new Set(AXIS_ORDER);

function die(msg) {
  console.error(`compose: ${msg}`);
  process.exit(1);
}

// --- frontmatter parsing ----------------------------------------------------
// Supports the minimal subset our lesson files use: `key: scalar` and list
// values written either inline (`scope: [a, b]`) or as a `- item` block.
function parseFrontmatter(text, relPath) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) die(`${relPath}:1  missing YAML frontmatter`);
  const body = m[1];
  const lines = body.split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) die(`${relPath}: cannot parse frontmatter line: "${line}"`);
    const key = kv[1];
    let rest = kv[2].trim();
    if (rest.startsWith("[") && rest.endsWith("]")) {
      // inline list
      data[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
    } else if (rest === "") {
      // could be an empty scalar or the start of a `- ` block list
      const block = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        block.push(lines[j].replace(/^\s*-\s+/, "").trim());
        j++;
      }
      if (block.length) { data[key] = block; i = j; }
      else { data[key] = ""; i++; }
    } else {
      data[key] = rest;
      i++;
    }
  }
  return data;
}

// --- collect + validate -----------------------------------------------------
function walkLessons() {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md") && name !== "INDEX.md") files.push(full);
    }
  }
  walk(LESSONS_DIR);
  return files.sort();
}

function axisOf(tag) {
  if (tag === "universal" || tag === "agent-process") return tag;
  const idx = tag.indexOf(":");
  return idx === -1 ? tag : tag.slice(0, idx);
}

function loadLessons() {
  const ids = new Map();
  const lessons = [];
  for (const file of walkLessons()) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const fm = parseFrontmatter(readFileSync(file, "utf8"), rel);
    for (const req of ["id", "title", "scope", "status"]) {
      if (!fm[req] || (Array.isArray(fm[req]) && fm[req].length === 0)) {
        die(`${rel}: missing required frontmatter field "${req}"`);
      }
    }
    const scope = Array.isArray(fm.scope) ? fm.scope : [fm.scope];
    for (const tag of scope) {
      if (!KNOWN_AXES.has(axisOf(tag))) {
        die(`${rel}: unknown axis in scope tag "${tag}" (known: ${[...KNOWN_AXES].join(", ")})`);
      }
    }
    if (!["active", "deprecated", "superseded"].includes(fm.status)) {
      die(`${rel}: invalid status "${fm.status}" (active|deprecated|superseded)`);
    }
    if (fm.status === "superseded" && !fm.superseded_by) {
      die(`${rel}: status superseded but superseded_by is empty`);
    }
    if (ids.has(fm.id)) {
      die(`${rel}: duplicate id "${fm.id}" (also in ${ids.get(fm.id)})`);
    }
    ids.set(fm.id, rel);
    lessons.push({ ...fm, scope, rel });
  }
  return lessons;
}

// Most-specific axis present in a scope (lowest AXIS_ORDER index).
function primaryAxisRank(scope) {
  let best = AXIS_ORDER.length;
  for (const tag of scope) {
    const r = AXIS_ORDER.indexOf(axisOf(tag));
    if (r !== -1 && r < best) best = r;
  }
  return best;
}

// --- profile matching -------------------------------------------------------
function readProfile(lockPath) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (e) {
    die(`cannot read/parse lock file ${lockPath}: ${e.message}`);
  }
  const p = lock.profile || {};
  return {
    vendor: p.vendor || null,
    archetype: p.archetype || null,
    stacks: new Set(p.stacks || []),
    env: new Set(p.env || []),
    libraryCommit: lock.libraryCommit || null,
  };
}

function tagMatches(tag, profile) {
  if (tag === "universal" || tag === "agent-process") return true;
  const [axis, id] = tag.split(":");
  switch (axis) {
    case "vendor": return profile.vendor === id;
    case "stack": return profile.stacks.has(id);
    case "env": return profile.env.has(id);
    case "archetype": return profile.archetype === id;
    case "project": return false; // never in the library
    default: return false;
  }
}

// AND across axes, OR within an axis.
function lessonMatches(lesson, profile) {
  const byAxis = new Map();
  for (const tag of lesson.scope) {
    const a = axisOf(tag);
    if (!byAxis.has(a)) byAxis.set(a, []);
    byAxis.get(a).push(tag);
  }
  for (const [, tags] of byAxis) {
    if (!tags.some((t) => tagMatches(t, profile))) return false;
  }
  return true;
}

// --- outputs ----------------------------------------------------------------
// Write a generated file idempotently and without churning line endings: match
// the existing file's EOL convention (so a CRLF working tree on Windows stays
// CRLF), and skip the write entirely when content is unchanged. Returns whether
// a write happened so `--index` can report silent-no-change vs. updated.
function writeGenerated(path, contentLf) {
  let eol = "\n";
  let existing = null;
  if (existsSync(path)) {
    existing = readFileSync(path, "utf8");
    if (existing.includes("\r\n")) eol = "\r\n";
  }
  const next = eol === "\r\n" ? contentLf.replace(/\n/g, "\r\n") : contentLf;
  if (existing === next) return false;
  writeFileSync(path, next);
  return true;
}

function buildIndex(lessons) {
  const sorted = [...lessons].sort((a, b) => a.id.localeCompare(b.id));
  const out = [
    "# Lessons index",
    "",
    "_Generated by `node scripts/compose.mjs --index` — do not edit by hand._",
    "",
    "One line per lesson: `id — title — [scope] — status`.",
    "",
  ];
  for (const l of sorted) {
    out.push(`- \`${l.id}\` — ${l.title} — [${l.scope.join(", ")}] — ${l.status}`);
  }
  out.push("");
  return out.join("\n");
}

function composeInEffect(lessons, profile) {
  const active = lessons.filter(
    (l) => l.status === "active" && lessonMatches(l, profile)
  );
  active.sort(
    (a, b) => primaryAxisRank(a.scope) - primaryAxisRank(b.scope) || a.id.localeCompare(b.id)
  );
  const out = ["## Lessons in effect", ""];
  if (active.length === 0) {
    out.push("_No library lessons match this project's profile._", "");
    return out.join("\n");
  }
  out.push(
    "_Generated from the agent-templates library via " +
      "`node scripts/compose.mjs --profile .claude/.template.lock`. " +
      "Most-specific axis first._",
    ""
  );
  let lastAxisRank = -1;
  for (const l of active) {
    const rank = primaryAxisRank(l.scope);
    if (rank !== lastAxisRank) {
      out.push(`### ${AXIS_ORDER[rank]}`, "");
      lastAxisRank = rank;
    }
    out.push(`- **${l.title}** \`[${l.scope.join(", ")}]\``);
  }
  out.push("");
  return out.join("\n");
}

function changedSince(commit) {
  let out;
  try {
    out = execFileSync(
      "git",
      ["-C", ROOT, "diff", "--name-only", `${commit}..HEAD`, "--", "lessons/"],
      { encoding: "utf8" }
    );
  } catch (e) {
    console.error(
      `compose: warning — could not run git diff since "${commit}" ` +
        `(${e.message.split("\n")[0]}); skipping fan-out section.`
    );
    return null;
  }
  return new Set(
    out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.endsWith(".md"))
  );
}

function fanOutSection(lessons, profile, changedFiles) {
  const matched = lessons.filter(
    (l) =>
      l.status === "active" &&
      lessonMatches(l, profile) &&
      changedFiles.has(l.rel)
  );
  const out = ["", "## Re-hydration available (fan-out)", ""];
  if (matched.length === 0) {
    out.push("_No new matching lessons since the recorded library commit._", "");
    return out.join("\n");
  }
  out.push(
    "These lessons match this project's profile and were added/changed since " +
      "the library commit recorded in `.template.lock` — re-hydrate to inherit them:",
    ""
  );
  for (const l of matched) out.push(`- \`${l.id}\` — ${l.title}`);
  out.push("");
  return out.join("\n");
}

// --- main -------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1] ?? true;
}

const lessons = loadLessons(); // always validates

if (args.includes("--index")) {
  const relIndex = relative(ROOT, INDEX_PATH).split(sep).join("/");
  const changed = writeGenerated(INDEX_PATH, buildIndex(lessons));
  console.log(
    changed
      ? `compose: wrote ${relIndex} (${lessons.length} lessons).`
      : `compose: ${relIndex} already up to date (${lessons.length} lessons).`
  );
  process.exit(0);
}

const profilePath = flag("--profile");
if (typeof profilePath === "string") {
  const profile = readProfile(profilePath);
  process.stdout.write(composeInEffect(lessons, profile) + "\n");
  const since = flag("--since");
  if (typeof since === "string") {
    const changed = changedSince(since);
    if (changed) process.stdout.write(fanOutSection(lessons, profile, changed) + "\n");
  }
  process.exit(0);
}

console.error(
  "compose: nothing to do.\n" +
    "  node scripts/compose.mjs --index\n" +
    "  node scripts/compose.mjs --profile <.template.lock>\n" +
    "  node scripts/compose.mjs --profile <.template.lock> --since <libraryCommit>"
);
process.exit(2);
