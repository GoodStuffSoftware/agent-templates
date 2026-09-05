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

import { classifyModel, classifyEffort, isModelAvailable, effortSupported } from '../hooks/lib/context.mjs';

const est = (s) => Math.ceil(s.length / 4);
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
    const roster = [];
    let count = 0;
    for (const d of dirs) {
      for (const f of readdirSync(d).filter((x) => x.endsWith('.md'))) {
        count++;
        const fm = frontmatter(readFileSync(join(d, f), 'utf8'));
        const rel = join(basename(d), f);
        roster.push({ name: fm.name || f.replace(/\.md$/, ''), model: fm.model || '', effort: fm.effort || '', rel });
        // An omitted model inherits the LEAD's tier - the most expensive
        // default available, and the mechanism behind unexamined premium fan-out.
        if (!fm.model) findings.push(`${rel}: NO model - inherits the lead's tier`);
        // Only ask for an effort where the model actually takes one. A tier with
        // a single mode has nothing to declare, and demanding a value there
        // would push people into writing one that does nothing — which is the
        // very confusion this check exists to remove.
        if (!fm.effort && fm.model && effortSupported(fm.model, 'high').ok) {
          findings.push(`${rel}: no effort set`);
        }
        if (fm.model && DATED_MODEL.test(fm.model)) {
          findings.push(`${rel}: dated model id "${fm.model}" - pin by alias instead`);
        }
        if (fm.model && /fable/i.test(fm.model)) {
          findings.push(`${rel}: pinned to FABLE - needs a written warrant or a downgrade`);
        }
        if (fm.effort === 'max') findings.push(`${rel}: effort=max - reserve for frontier work`);
      }
    }
    // Reviewer parity: a reviewer is sized to the writer it gates, never
    // discounted below it. A weaker reviewer catches the errors it would itself
    // have avoided and waves through the ones it would itself have made — which
    // is exactly the novel-error class a stronger writer produces. The saving is
    // taken precisely where the gate was supposed to earn its keep.
    // One source of truth for tiers: the shared, data-driven table. A second
    // hardcoded copy here would drift out of step with the guards, and the two
    // disagreeing is worse than either being wrong alone.
    const tierOf = (m) => classifyModel(m).rank;

    // A model the table does not recognise is worth saying out loud. It is
    // treated as premium so nothing slips through, but silently applying the
    // strict path would hide that the table needs updating.
    for (const a of roster) {
      if (a.model && !classifyModel(a.model).known) {
        findings.push(`${a.rel}: model "${a.model}" is not in the tier table — treated as premium; update config/model-tiers.json`);
      }
    }

    // A model that classifies fine but is not reachable on this account. The
    // spawn fails at runtime and reads as a broken agent rather than a config
    // mistake, so it is worth catching in the roster instead.
    for (const a of roster) {
      if (a.model && !isModelAvailable(a.model)) {
        findings.push(`${a.rel}: pinned to "${a.model}", which is marked unavailable on this account`);
      }
      if (a.effort && !classifyEffort(a.effort).known) {
        findings.push(`${a.rel}: effort "${a.effort}" is not a known level`);
      }
      // Effort availability is per-model. An effort a model does not accept is
      // not "less thinking" — it is a parameter that model ignores, so the
      // definition reads as a deliberate choice that has no effect.
      if (a.model && a.effort) {
        const sup = effortSupported(a.model, a.effort);
        if (!sup.ok) findings.push(`${a.rel}: effort "${a.effort}" on "${a.model}" — ${sup.reason}`);
      }
    }

    const reviewers = roster.filter((a) => /review/i.test(a.name));
    const writers = roster.filter((a) => /architect|builder|writer|implement/i.test(a.name));
    if (reviewers.length && writers.length) {
      const topWriter = writers.reduce((a, b) => (tierOf(b.model) > tierOf(a.model) ? b : a));
      for (const r of reviewers) {
        if (tierOf(r.model) > 0 && tierOf(topWriter.model) > tierOf(r.model)) {
          findings.push(
            `${r.name}: reviewer on "${r.model}" gates ${topWriter.name} on `
            + `"${topWriter.model}" — a reviewer must match the tier it reviews`,
          );
        }
        // Effort may exceed the writer's; it must not fall below it. Refutation
        // is a search problem, so a reviewer given LESS thinking than the writer
        // had is being asked to find a needle with a shorter look.
        const rE = classifyEffort(r.effort);
        const wE = classifyEffort(topWriter.effort);
        if (rE.rank > 0 && wE.rank > 0 && rE.rank < wE.rank) {
          findings.push(
            `${r.name}: reviewer effort "${r.effort}" is below ${topWriter.name}'s `
            + `"${topWriter.effort}" — reviewer effort may exceed the writer's, never fall below`,
          );
        }
      }
    }

    const bad = findings.some((x) => /NO model|FABLE|must match the tier/.test(x));
    return {
      status: bad ? 'fail' : (findings.length ? 'warn' : 'ok'),
      findings,
      data: { count, roster },
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
    const premium = rows.filter((r) => r.model && r.model !== '(inherited)' && classifyModel(r.model).premium);
    const byModel = {};
    for (const r of rows) byModel[r.model || '?'] = (byModel[r.model || '?'] || 0) + 1;

    const findings = [];
    if (inherited.length) {
      findings.push(`${inherited.length}/${rows.length} spawns specified NO model (inherited the lead's tier)`);
    }
    findings.push(`mix: ${Object.entries(byModel).map(([m, n]) => `${m}=${n}`).join(', ')}`);
    const declared = rows.filter((r) => r.fit);
    if (declared.length) {
      const n = (v) => declared.filter((r) => r.fit === v).length;
      findings.push('fit where weight was declared: over=' + n('over') + ' under=' + n('under') + ' fit=' + n('fit') + ' of ' + declared.length +
        (n('under') ? ' - under-provisioned spawns ship wrong code; see the evaluate skill' : ''));
    }
    if (!rows.some((r) => /haiku/i.test(r.model || ''))) {
      findings.push('no haiku spawns recorded - the cheapest tier is going unused');
    }
    return {
      status: (inherited.length || rows.some((r) => r.fit === 'under')) ? 'warn' : 'ok',
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
    // Version parity. marketplace.json may declare plugins[].version, and the
    // docs say Claude Code always prefers plugin.json - so the two must never
    // drift. The claude.ai plugin directory keys on the manifest, so a release
    // that bumps plugin.json alone is invisible there (it sat at 0.1.1 through
    // eight releases). Enforced here so it is a check, not a memory.
    if (existsSync(mk)) {
      try {
        const m = JSON.parse(readFileSync(mk, 'utf8'));
        for (const e of m.plugins || []) {
          if (!e.source || !String(e.source).startsWith('.')) continue; // external sources: nothing local to compare
          const pj = join(ctx.target, e.source, '.claude-plugin', 'plugin.json');
          if (!existsSync(pj)) continue;
          const v = JSON.parse(readFileSync(pj, 'utf8')).version;
          if (!e.version) {
            findings.push('marketplace: ' + e.name + ' declares no version in marketplace.json - the claude.ai directory will not see releases; set it equal to plugin.json (' + v + ')');
          } else if (v && v !== e.version) {
            failed = true;
            findings.push('marketplace: ' + e.name + ' is ' + e.version + ' in marketplace.json but ' + v + ' in plugin.json - bump both on every release');
          }
        }
      } catch (err) { findings.push('marketplace: could not compare versions: ' + err.message); }
    }
    return { status: failed ? 'fail' : (findings.length ? 'warn' : 'ok'), findings };
  },
};

// --- 8. routing doc freshness ---------------------------------------------
// docs/ROUTING.md is generated from config/model-tiers.json. A generated doc
// that is not regenerated is a hand-written doc with extra steps: it drifts the
// moment the config changes, and a reader then sees a table the guards no
// longer enforce. This check makes "self-generating" enforced rather than
// remembered — and --fix regenerates it.
const routingDoc = {
  id: 'routing-doc',
  title: 'Routing table doc matches config',
  vendor: 'anthropic',
  fixable: true,
  run(ctx) {
    const script = join(ctx.pluginRoot, 'scripts', 'routing-table.mjs');
    const docPath = join(ctx.pluginRoot, 'docs', 'ROUTING.md');
    if (!existsSync(script)) return { status: 'skip', findings: ['routing-table.mjs not found'] };
    let fresh;
    try {
      fresh = execSync(`node "${script}"`, { encoding: 'utf8', timeout: 20000 });
    } catch (e) {
      return { status: 'error', findings: [`renderer threw: ${e.message}`] };
    }
    if (!existsSync(docPath)) {
      return { status: 'warn', findings: ['docs/ROUTING.md does not exist - --fix generates it'], data: { fresh, docPath } };
    }
    const norm = (s) => s.replace(/\r\n/g, '\n');
    const same = norm(readFileSync(docPath, 'utf8')) === norm(fresh);
    return {
      status: same ? 'ok' : 'warn',
      findings: same ? [] : ['docs/ROUTING.md is STALE relative to config/model-tiers.json - readers see a table the guards no longer enforce; --fix regenerates'],
      data: { fresh, docPath },
    };
  },
  fix(ctx, prev) {
    writeFileSync(prev.data.docPath, prev.data.fresh);
    return ['regenerated docs/ROUTING.md from config'];
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
  routingDoc,
];
