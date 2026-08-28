// Memory doctor — detect and repair drift in a project's memory directory.
//
// The index is the source of truth for what is persisted. A file on disk that
// the index does not link is not "extra memory" — it is UNREACHABLE, and the
// dangerous case is a standing RULE in that state: you believe it is in effect,
// and it can never be recalled. Same failure shape as a guard that silently
// stopped matching.
//
// Repairs are strictly non-destructive: files are MOVED to archive/, never
// deleted, and index entries are only ever ADDED. Merging and consolidating
// overlapping memories is deliberately NOT automated — that needs judgement and
// a human, and doing it wrong loses knowledge permanently.
//
// Usage:
//   node memory-doctor.mjs [--dir <memory-dir>] [--fix] [--json]

import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const HISTORICAL = (process.env.CLAUDE_PLUGIN_OPTION_memory_archive_prefixes
  || 'findings_,bugs,handoff-').split(',').map((s) => s.trim()).filter(Boolean);

// The character class here is load-bearing. An earlier version used [^)]+ ,
// which matches across newlines — so ONE unbalanced "(" anywhere in the file
// swallowed everything up to the next ".md)" and reported an unrelated entry
// as a broken link. Confine a link to a single line, and forbid nested parens.
const LINK_RE = /\(([^()\r\n]+\.md)\)/g;

function resolveDir() {
  const explicit = val('--dir');
  if (explicit) return explicit;
  const enc = process.cwd().replace(/[:\/]/g, '-');
  const d = join(homedir(), '.claude', 'projects', enc, 'memory');
  return existsSync(d) ? d : null;
}

const dir = resolveDir();
if (!dir || !existsSync(dir)) {
  console.error('memory-doctor: no memory directory found (pass --dir)');
  process.exit(1);
}

const indexPath = join(dir, 'MEMORY.md');
if (!existsSync(indexPath)) {
  console.error(`memory-doctor: no MEMORY.md in ${dir}`);
  process.exit(1);
}

const est = (s) => Math.ceil(s.length / 4);
const indexRaw = readFileSync(indexPath, 'utf8');
const linked = new Set([...indexRaw.matchAll(LINK_RE)].map((m) => m[1]));

const onDisk = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
const isHistorical = (n) => HISTORICAL.some((p) => n.startsWith(p));

const orphans = onDisk.filter((f) => !linked.has(f));
const broken = [...linked].filter((f) => !existsSync(join(dir, f)));
const historicalOrphans = orphans.filter(isHistorical);
const ruleOrphans = orphans.filter((f) => !isHistorical(f));

function frontmatter(file) {
  try {
    const t = readFileSync(join(dir, file), 'utf8');
    const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) out[kv[1]] = kv[2].trim();
    }
    return out;
  } catch { return {}; }
}

// Parens and newlines are STRIPPED, not escaped. A truncated description must
// never be able to emit an unbalanced "(" into the index — see LINK_RE above
// for what that costs.
function hookText(desc) {
  const flat = String(desc).replace(/[\r\n]+/g, ' ').replace(/[()]/g, '').trim();
  return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
}

const report = {
  dir,
  filesOnDisk: onDisk.length,
  indexed: linked.size,
  indexTokens: est(indexRaw),
  orphans: orphans.length,
  historicalOrphans: historicalOrphans.map((f) => ({ file: f, tokens: est(readFileSync(join(dir, f), 'utf8')) })),
  ruleOrphans: ruleOrphans.map((f) => {
    const fm = frontmatter(f);
    return { file: f, name: fm.name || f.replace(/\.md$/, ''), description: fm.description || '(no description)' };
  }),
  brokenLinks: broken,
  fixed: null,
};

if (flag('--fix')) {
  const fixed = { archived: [], relinked: [], backup: null };

  if (historicalOrphans.length) {
    const archive = join(dir, 'archive');
    mkdirSync(archive, { recursive: true });
    for (const f of historicalOrphans) {
      try { renameSync(join(dir, f), join(archive, f)); fixed.archived.push(f); } catch {}
    }
  }

  if (ruleOrphans.length) {
    const backup = `${indexPath}.bak-doctor-${new Date().toISOString().slice(0, 10)}`;
    copyFileSync(indexPath, backup);
    fixed.backup = backup;

    const nl = indexRaw.includes('\r\n') ? '\r\n' : '\n';
    const lines = report.ruleOrphans.map((o) => {
      fixed.relinked.push(o.file);
      return `- [${o.name}](${o.file}) — ${hookText(o.description)}`;
    });
    const block = [
      '',
      '## Recovered by memory-doctor',
      '',
      'These files existed on disk but were not linked from this index, so they could',
      'never be recalled. Review the wording and fold them into the sections above.',
      '',
      ...lines,
      '',
    ].join(nl);
    writeFileSync(indexPath, indexRaw.replace(/\s*$/, '') + nl + block);
  }

  report.fixed = fixed;
}

if (flag('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`memory-doctor — ${dir}`);
  console.log(`  files on disk : ${report.filesOnDisk}`);
  console.log(`  indexed       : ${report.indexed}`);
  console.log(`  index size    : ~${report.indexTokens} tokens (loaded EVERY session)`);
  console.log(`  broken links  : ${broken.length}`);
  for (const b of broken) console.log(`      -> ${b}`);
  console.log(`  orphans       : ${orphans.length}  (${historicalOrphans.length} historical, ${ruleOrphans.length} live rules)`);
  if (report.ruleOrphans.length) {
    console.log('\n  UNREACHABLE RULES — believed in effect, cannot be recalled:');
    for (const o of report.ruleOrphans) console.log(`    ${o.file}`);
  }
  if (report.fixed) {
    console.log(`\n  FIXED: archived ${report.fixed.archived.length}, re-linked ${report.fixed.relinked.length}`);
    if (report.fixed.backup) console.log(`  index backup: ${report.fixed.backup}`);
  } else if (orphans.length || broken.length) {
    console.log('\n  Re-run with --fix to archive historical orphans and re-link unreachable rules.');
    console.log('  (Nothing is ever deleted. Consolidating duplicates stays manual.)');
  }
}
