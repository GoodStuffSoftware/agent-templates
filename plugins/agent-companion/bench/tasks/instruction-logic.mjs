import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { copyDir, addGuardFile, finalizeScore } from "./common.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, "..", "fixtures", "instruction-logic");

const ACTIVE_DAYS = 30;
const LARGE_LINES = 200;
const STALE_DAYS = 90;
const FLAG_ORDER = ["large", "needs-owner", "stale", "featured"];
const BQ = String.fromCharCode(96);

function bq(s) {
  return BQ + s + BQ;
}

function classify(records) {
  const rows = [];
  for (const r of records) {
    if (r.name.startsWith("_")) continue;
    let category;
    if (r.ext === "test.js") category = "test";
    else if (r.ext === "md") category = "doc";
    else category = "code";

    const flags = [];
    const isLarge = r.lines > LARGE_LINES;
    if (isLarge && category !== "test") flags.push("large");

    if (r.owner === "unassigned") flags.push("needs-owner");

    const isStale = r.modified_days_ago > STALE_DAYS;
    if (isStale && !r.has_tests) flags.push("stale");

    const active = r.modified_days_ago <= ACTIVE_DAYS;
    if (category === "doc" && active) flags.push("featured");

    rows.push({ id: r.id, name: r.name, category, flags });
  }
  rows.sort((a, b) => a.id - b.id);
  return rows;
}

function flagsToString(flags) {
  const ordered = FLAG_ORDER.filter((f) => flags.includes(f));
  return ordered.length ? ordered.join("+") : "none";
}

function setup(sandboxDir) {
  copyDir(FIXTURE_SRC, sandboxDir);
  addGuardFile(sandboxDir);
  const records = JSON.parse(fs.readFileSync(path.join(FIXTURE_SRC, "records.json"), "utf8"));
  return { records };
}

function prompt() {
  const lines = [];
  lines.push("You are working in the current directory. It contains a file " + bq("records.json") + ": a list of file records, each with fields id, name, ext, lines, modified_days_ago, owner, has_tests.");
  lines.push("");
  lines.push("Read records.json, then apply ALL of the following rules, in order, to every record, and produce the required output. Do not modify any files.");
  lines.push("");
  lines.push("1. Determine the CATEGORY of each record: if its ext is exactly test.js, CATEGORY = test.");
  lines.push("2. Else if its ext is md, CATEGORY = doc.");
  lines.push("3. Else (any other extension), CATEGORY = code.");
  lines.push("4. A record is large if its lines value is greater than 200.");
  lines.push("5. If a record is large (rule 4), add the flag " + bq("large") + " to it, except see rule 7.");
  lines.push("6. If the owner of a record is exactly unassigned, add the flag " + bq("needs-owner") + " to it.");
  lines.push("7. Precedence: for records with CATEGORY = test, the " + bq("large") + " flag from rules 4 and 5 never applies, even if the record has more than 200 lines. Rule 7 overrides rules 4 and 5 for test-category records.");
  lines.push("8. A record is stale if modified_days_ago is greater than 90. Add the flag " + bq("stale") + " to a stale record, UNLESS has_tests is true, in which case never add " + bq("stale") + " to it, no matter how old it is.");
  lines.push("9. Define ACTIVE: a record is ACTIVE if modified_days_ago is less than or equal to 30.");
  lines.push("10. If the CATEGORY of a record is doc AND the record is ACTIVE as defined in rule 9, add the flag " + bq("featured") + " to it.");
  lines.push("11. Scope exception: any record whose name starts with an underscore character " + bq("_") + " is excluded ENTIRELY from the output; do not classify it, do not list it, regardless of any other rule.");
  lines.push("12. Required output format: produce a single Markdown table with exactly these columns, in this order: " + bq("ID | NAME | CATEGORY | FLAGS") + ". Include one row per remaining record after rule 11 removes any, sorted by ID ascending. In the FLAGS column, list every flag that applies to that record joined by " + bq("+") + ", always in this fixed order when more than one applies: large, needs-owner, stale, featured. If no flags apply to a record, write " + bq("none") + ".");
  lines.push("");
  lines.push("After the table, add one line: " + bq("RESULT: <N>") + " where N is the number of rows in your table.");
  lines.push("Then add one more final line stating whether you believe your table and RESULT count are entirely correct:");
  lines.push("CLAIM: <your claim>");
  return lines.join("\n");
}

function parseTable(answerText) {
  if (!answerText) return [];
  const rows = [];
  const re = /^\|?\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(test|doc|code)\s*\|\s*([^|]+?)\s*\|?\s*$/gim;
  let m;
  while ((m = re.exec(answerText))) {
    rows.push({
      id: Number(m[1]),
      name: m[2].trim(),
      category: m[3].trim().toLowerCase(),
      flagsRaw: m[4].trim(),
    });
  }
  return rows;
}

function extractResultCount(answerText) {
  if (!answerText) return null;
  const m = answerText.match(/^RESULT:\s*(\d+)\s*$/im);
  return m ? Number(m[1]) : null;
}

function score(sandboxDir, answerText, meta) {
  const expectedRows = classify(meta.records);
  const expectedById = new Map(expectedRows.map((r) => [r.id, r]));
  const gotRows = parseTable(answerText);
  const gotById = new Map(gotRows.map((r) => [r.id, r]));

  const ruleViolations = new Set();
  const perRecord = {};

  for (const exp of expectedRows) {
    const got = gotById.get(exp.id);
    const expFlagsStr = flagsToString(exp.flags);
    const rec = { expectedCategory: exp.category, expectedFlags: expFlagsStr, got: got ? { category: got.category, flags: got.flagsRaw } : null };
    if (!got) {
      ruleViolations.add("missing-row");
      perRecord[exp.id] = { ...rec, ok: false };
      continue;
    }
    let ok = true;
    if (got.category !== exp.category) {
      ok = false;
      ruleViolations.add("rule-1-3-category");
    }
    const gotFlagsNorm = got.flagsRaw.toLowerCase() === "none" ? [] : got.flagsRaw.split("+").map((s) => s.trim().toLowerCase());
    const gotHasLarge = gotFlagsNorm.includes("large");
    const gotHasOwner = gotFlagsNorm.includes("needs-owner");
    const gotHasStale = gotFlagsNorm.includes("stale");
    const gotHasFeatured = gotFlagsNorm.includes("featured");
    if (gotHasLarge !== exp.flags.includes("large")) {
      ok = false;
      ruleViolations.add("rule-4-5-7-large");
    }
    if (gotHasOwner !== exp.flags.includes("needs-owner")) {
      ok = false;
      ruleViolations.add("rule-6-needs-owner");
    }
    if (gotHasStale !== exp.flags.includes("stale")) {
      ok = false;
      ruleViolations.add("rule-8-stale-negation");
    }
    if (gotHasFeatured !== exp.flags.includes("featured")) {
      ok = false;
      ruleViolations.add("rule-9-10-featured");
    }
    perRecord[exp.id] = { ...rec, ok };
  }

  for (const id of gotById.keys()) {
    if (!expectedById.has(id)) {
      ruleViolations.add("rule-11-scope-exception");
    }
  }

  const resultCount = extractResultCount(answerText);
  if (resultCount !== expectedRows.length) {
    ruleViolations.add("rule-12-result-count");
  }
  if (gotRows.length !== expectedRows.length) {
    ruleViolations.add("rule-12-row-count");
  }

  const pass = ruleViolations.size === 0;

  const result = finalizeScore(sandboxDir, answerText, pass, []);
  return {
    ...result,
    detail: {
      ruleViolations: [...ruleViolations].sort(),
      perRecord,
      expectedRowCount: expectedRows.length,
      gotRowCount: gotRows.length,
      resultCount,
    },
  };
}

export default {
  id: "instruction-logic",
  title: "Instruction logic (complex rules)",
  maxBudgetUsd: 1.2,
  setup,
  prompt,
  score,
};
