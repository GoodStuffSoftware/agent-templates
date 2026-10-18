#!/usr/bin/env node
// Regenerates scripts/lesson-baseline.json: the lessons over the brevity cap
// that predate it, keyed by path with a body digest. leak-check holds every
// lesson NOT in this file (new) or whose body differs (changed) to the
// 150-word cap. Normally never needed: trim a lesson instead of baselining it.
// Usage: node scripts/lesson-baseline.mjs   (run from the repo root)
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { lessonBody, lessonDigest } from "./leak-check.mjs";

const root = process.cwd();
const cap = 150;

function walk(d) {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const lessons = {};
for (const f of walk(join(root, "lessons")).sort()) {
  const rel = relative(root, f).split(sep).join("/");
  if (!rel.endsWith(".md") || /(^|\/)(README|INDEX)\.md$/i.test(rel)) continue;
  const text = readFileSync(f, "utf8");
  if (lessonBody(text).split(/\s+/).filter(Boolean).length > cap) lessons[rel] = lessonDigest(text);
}
writeFileSync(join(root, "scripts", "lesson-baseline.json"), JSON.stringify({ lessons }, null, 2) + "\n");
console.log(`lesson-baseline: ${Object.keys(lessons).length} lesson(s) recorded`);
