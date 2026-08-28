// Check registry for the agent-companion audit runner.
//
// Every check is an independent object with the same shape, so checks can be
// selected, skipped, and chained without the runner knowing anything about
// them:
//
//   { id, title, fixable, run(ctx) -> { status, findings[], data? }, fix?(ctx, prev) }
//
// status is 'ok' | 'warn' | 'fail' | 'skip'. A check that cannot determine its
// answer returns 'skip' with a reason — never 'ok'. Reporting "fine" when you
// actually mean "could not tell" is the exact failure this plugin exists to
// prevent.

import {
  readFileSync, existsSync, readdirSync, mkdirSync, renameSync, copyFileSync, writeFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';

const est = (s) => Math.ceil(s.length / 4);
const PREMIUM = /fable|opus/i;
const DATED_MODEL = /-\d{6,8}$/;

export function memoryDirFor(target) {
  const enc = target.replace(/[:\\/]/g, '-');
  const direct = join(homedir(), '.claude', 'projects', enc, 'memory');
  if (existsSync(direct)) return direct;
  const base = join(homedir(), '.claude', 'projects');
  try {
    const leaf = target.split(/[\\/]/).filter(Boolean).pop();
    for (const c of readdirSync(base)) {
      if (leaf && c.endsWith(leaf)) {
        const p = join(base, c, 'memory');
        if (existsSync(p)) return p;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function historicalPrefixes() {
  return (process.env.CLAUDE_PLUGIN_OPTION_memory_archive_prefixes || 'findings_,bugs,handoff-')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

// --- 1. memory index reachability ---------------------------------------
const memoryIndex = {
  id: 'memory-index',
  title: 'Memory index reachability',
  vendor: 'anthropic',
  fixable: true,
  run(ctx) {
    const dir = ctx.memoryDir;
    if (!dir) return { status: 'skip', findings: ['no memory directory for this target'] };
    const idxPath = join(dir, 'MEMORY.md');
    if (!existsSync(idxPath)) return { status: 'skip', findings: ['no MEMORY.md in memory dir'] };

    const idx = readFileSync(idxPath, 'utf8');
    const hist = historicalPrefixes();
    const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    // Substring, not regex: a link is literally "(name.md)" and needs no escaping.
    const orphans = files.filter((f) => !idx.includes(`(${f})`));
    const ruleOrphans = orphans.filter((f) => !hist.some((p) => f.startsWith(p)));
    const histOrphans = orphans.filter((f) => hist.some((p) => f.startsWith(p)));
    const broken = [...idx.matchAll(/\(([^()\r\n]+\.md)\)/g)]
      .map((m) => m[1])
      .filter((f) => !existsSync(join(dir, f)));

    const findings = [];
    for (const f of ruleOrphans) findings.push(`UNREACHABLE RULE: ${f} (on disk, absent from index)`);
    for (const f of broken) findings.push(`BROKEN LINK: ${f} (in index, absent from disk)`);
    if (histOrphans.length) findings.push(`${histOrphans.length} historical file(s) unindexed - archivable`);

    return {
      status: (ruleOrphans.length || broken.length) ? 'fail' : (histOrphans.length ? 'warn' : 'ok'),
      findings,
      data: { ruleOrphans, histOrphans, broken, dir, idxPath },
    };
  },
  fix(ctx, prev) {
    const { ruleOrphans, histOrphans, dir, idxPath } = prev.data;
    const done = [];
    if (histOrphans.length) {
      const archive = join(dir, 'archive');
      mkdirSync(archive, { recursive: true });
      for (const f of histOrphans) {
        try { renameSync(join(dir, f), join(archive, f)); done.push(`archived ${f}`); } catch { /* skip */ }
      }
    }
    if (ruleOrphans.length) {
      const idx = readFileSync(idxPath, 'utf8');
      const nl = idx.includes('\r\n') ? '\r\n' : '\n';
      copyFileSync(idxPath, `${idxPath}.bak-audit-${new Date().toISOString().slice(0, 10)}`);
      const lines = ruleOrphans.map((f) => {
        const fm = frontmatter(readFileSync(join(dir, f), 'utf8'));
        const name = fm.name || f.replace(/\.md$/, '');
        // Parens are stripped, never escaped: a truncated description must not
        // be able to emit an unbalanced "(" into the index.
        const flat = String(fm.description || 'no description')
          .replace(/[\r\n]+/g, ' ').replace(/[()]/g, '').trim();
        const hook = flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
        done.push(`re-linked ${f}`);
        return `- [${name}](${f}) - ${hook}`;
      });
      const block = [
        '',
        '## Recovered by agent-companion audit',
        '',
        'These files were on disk but not linked from this index, so they could never',
        'be recalled. Review the wording and fold them into the sections above.',
        '',
        ...lines,
        '',
      ].join(nl);
      writeFileSync(idxPath, idx.replace(/\s*$/, '') + nl + block);
    }
    return done;
  },
};

// --- 2. instruction budget ----------------------------------------------
const instructionBudget = {
  id: 'instruction-budget',
  title: 'Always-loaded instruction budget',
  vendor: 'anthropic',
  fixable: false,
  run(ctx) {
    const budget = Number(process.env.CLAUDE_PLUGIN_OPTION_memory_budget_tokens || 3000);
    const cands = [
      ['project CLAUDE.md', join(ctx.target, 'CLAUDE.md')],
      ['global CLAUDE.md', join(homedir(), '.claude', 'CLAUDE.md')],
    ];
    if (ctx.memoryDir) cands.push(['memory index', join(ctx.memoryDir, 'MEMORY.md')]);

    const findings = [];
    for (const [label, file] of cands) {
      if (!existsSync(file)) continue;
      const t = readFileSync(file, 'utf8');
      const tok = est(t);
      const lines = t.split('\n').length;
      if (tok > budget) findings.push(`${label}: ~${tok} tok / ${lines} lines (budget ${budget})`);
      // Anthropic's published guidance applies to CLAUDE.md specifically.
      if (label.includes('CLAUDE.md') && lines > 200) {
        findings.push(`${label}: ${lines} lines exceeds the documented 200-line guidance`);
      }
    }
    return { status: findings.length ? 'warn' : 'ok', findings };
  },
};

// --- 3. agent definitions ------------------------------------------------
const agentDefs = {
  id: 'agent-defs',
  title: 'Sub-agent model/effort routing',
  vendor: 'anthropic',
  fixable: false,
  run(ctx) {
    const dirs = [join(ctx.target, '.claude', 'agents'), join(ctx.target, 'agents')].filter(existsSync);
    if (!dirs.length) return { status: 'skip', findings: ['no agents directory under this target'] };

    const findings = [];
    let count = 0;
    for (const d of dirs) {
      for (const f of readdirSync(d).filter((x) => x.endsWith('.md'))) {
        count++;
        const fm = frontmatter(readFileSync(join(d, f), 'utf8'));
        const rel = join(basename(d), f);
        // An omitted model inherits the LEAD's tier - the most expensive
        // default available, and the mechanism behind unexamined premium fan-out.
        if (!fm.model) findings.push(`${rel}: NO model - inherits the lead's tier`);
        if (!fm.effort) findings.push(`${rel}: no effort set`);
        if (fm.model && DATED_MODEL.test(fm.model)) {
          findings.push(`${rel}: dated model id "${fm.model}" - pin by alias instead`);
        }
        if (fm.model && /fable/i.test(fm.model)) {
          findings.push(`${rel}: pinned to FABLE - needs a written warrant or a downgrade`);
        }
        if (fm.effort === 'max') findings.push(`${rel}: effort=max - reserve for frontier work`);
      }
    }
    const bad = findings.some((x) => /NO model|FABLE/.test(x));
    return {
      status: bad ? 'fail' : (findings.length ? 'warn' : 'ok'),
      findings,
      data: { count },
    };
  },
};

// --- 4. harness drift ----------------------------------------------------
const harnessDrift = {
  id: 'harness-drift',
  title: 'Claude Code harness drift',
  vendor: 'anthropic',
  fixable: false,
  run(ctx) {
    let version;
    try {
      // execSync, not execFileSync: on Windows `claude` is a .cmd shim, which
      // only resolves through a shell. execFileSync silently failed here and the
      // check reported SKIP — a drift detector that never runs is worse than none.
      version = execSync('claude --version', { encoding: 'utf8', timeout: 20000 }).trim();
    } catch {
      return { status: 'skip', findings: ['could not run `claude --version`'] };
    }
    const bl = join(ctx.dataDir, 'baseline.json');
    let prev = {};
    try { if (existsSync(bl)) prev = JSON.parse(readFileSync(bl, 'utf8')); } catch { /* ignore */ }

    const findings = [];
    if (prev.version && prev.version !== version) {
      findings.push(`version changed: ${prev.version} -> ${version} - re-verify hook matchers, run the canary`);
    }
    try {
      mkdirSync(ctx.dataDir, { recursive: true });
      writeFileSync(bl, JSON.stringify({ ...prev, version }, null, 2));
    } catch { /* ignore */ }

    const unknownFile = join(ctx.dataDir, 'unknown-agent-types.jsonl');
    if (existsSync(unknownFile)) {
      const types = new Set(
        readFileSync(unknownFile, 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l).agent_type; } catch { return null; } })
          .filter(Boolean),
      );
      if (types.size) findings.push(`unrecognised agent_type(s) seen: ${[...types].join(', ')}`);
    }
    return { status: findings.length ? 'warn' : 'ok', findings, data: { version } };
  },
};

// --- 5. guard canary -----------------------------------------------------
// Confirms the guards still FIRE, not merely that their config exists. A guard
// that stopped matching produces the same zero-denial record as a guard that
// was never tripped.
const guardCanary = {
  id: 'guard-canary',
  title: 'Guards actually fire (canary)',
  vendor: 'anthropic',
  fixable: false,
  run(ctx) {
    const hooks = join(ctx.pluginRoot, 'hooks');
    if (!existsSync(hooks)) return { status: 'skip', findings: ['plugin hooks directory not found'] };
    const findings = [];

    const probe = (script, payload) => {
      try {
        const out = execFileSync('node', [join(hooks, script)], {
          input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000,
        });
        return out.trim() ? JSON.parse(out) : null;
      } catch {
        return undefined;
      }
    };

    const denyCase = probe('spawn-guard.mjs', {
      session_id: 'canary',
      agent_type: 'main',
      tool_input: { model: 'claude-fable-5', prompt: 'canary probe, deliberately no warrant' },
    });
    if (denyCase === undefined) findings.push('spawn-guard did not run at all');
    else if (denyCase?.hookSpecificOutput?.permissionDecision !== 'deny') {
      findings.push('spawn-guard did NOT deny an unwarranted premium spawn - the guard is inert');
    }

    const workerCase = probe('delegation-guard.mjs', {
      session_id: 'canary-sub', agent_type: 'subagent', tool_name: 'Bash',
    });
    if (workerCase?.hookSpecificOutput?.permissionDecision === 'deny') {
      findings.push('delegation-guard DENIED a subagent - workers are being blocked');
    }

    return { status: findings.length ? 'fail' : 'ok', findings };
  },
};

// --- 6. spawn telemetry --------------------------------------------------
const spawnAudit = {
  id: 'spawn-audit',
  title: 'Spawn telemetry',
  vendor: 'anthropic',
  fixable: false,
  run(ctx) {
    const f = join(ctx.dataDir, 'spawns.jsonl');
    if (!existsSync(f)) return { status: 'skip', findings: ['no spawn telemetry recorded yet'] };
    const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (!rows.length) return { status: 'skip', findings: ['telemetry file is empty'] };

    const inherited = rows.filter((r) => r.model === '(inherited)');
    const premium = rows.filter((r) => PREMIUM.test(r.model || ''));
    const byModel = {};
    for (const r of rows) byModel[r.model || '?'] = (byModel[r.model || '?'] || 0) + 1;

    const findings = [];
    if (inherited.length) {
      findings.push(`${inherited.length}/${rows.length} spawns specified NO model (inherited the lead's tier)`);
    }
    findings.push(`mix: ${Object.entries(byModel).map(([m, n]) => `${m}=${n}`).join(', ')}`);
    if (!rows.some((r) => /haiku/i.test(r.model || ''))) {
      findings.push('no haiku spawns recorded - the cheapest tier is going unused');
    }
    return {
      status: inherited.length ? 'warn' : 'ok',
      findings,
      data: { total: rows.length, premium: premium.length },
    };
  },
};

// --- 7. plugin manifests -------------------------------------------------
// Added after shipping an invalid manifest to a marketplace. `claude plugin
// validate` existed the whole time and takes a second to run; the manifest had
// been written by copying a working reference plugin that happened not to use
// the field that was wrong, so there was nothing to compare against. Validating
// against a known-good EXAMPLE is not validating against the SCHEMA.
const pluginManifests = {
  id: 'plugin-manifest',
  title: 'Plugin / marketplace manifest validity',
  vendor: 'anthropic',
  fixable: false,
  run(ctx) {
    const targets = [];
    const mk = join(ctx.target, '.claude-plugin', 'marketplace.json');
    if (existsSync(mk)) targets.push(['marketplace', ctx.target]);

    const pluginsDir = join(ctx.target, 'plugins');
    if (existsSync(pluginsDir)) {
      for (const d of readdirSync(pluginsDir)) {
        const p = join(pluginsDir, d);
        if (existsSync(join(p, '.claude-plugin', 'plugin.json'))) targets.push([`plugin:${d}`, p]);
      }
    }
    if (existsSync(join(ctx.target, '.claude-plugin', 'plugin.json'))) {
      targets.push([`plugin:${basename(ctx.target)}`, ctx.target]);
    }
    if (!targets.length) return { status: 'skip', findings: ['no plugin or marketplace manifests here'] };

    const findings = [];
    let failed = false;
    for (const [label, path] of targets) {
      let out;
      try {
        // --strict so warnings (unknown fields, missing metadata) surface here
        // rather than at publish time. execSync for the Windows .cmd shim.
        out = execSync(`claude plugin validate "${path}" --strict`, { encoding: 'utf8', timeout: 60000 });
      } catch (e) {
        failed = true;
        const text = `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message;
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t.startsWith('❯') || /error|warning|failed/i.test(t)) findings.push(`${label}: ${t}`);
        }
        continue;
      }
      if (/warning/i.test(out)) findings.push(`${label}: passed with warnings`);
    }
    return { status: failed ? 'fail' : (findings.length ? 'warn' : 'ok'), findings };
  },
};

export const CHECKS = [
  memoryIndex,
  instructionBudget,
  agentDefs,
  harnessDrift,
  guardCanary,
  spawnAudit,
  pluginManifests,
];
