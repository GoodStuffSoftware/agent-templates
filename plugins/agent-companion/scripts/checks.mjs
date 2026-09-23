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
  readFileSync, existsSync, readdirSync, mkdirSync, renameSync, copyFileSync, writeFileSync, statSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';

import {
  classifyModel, classifyEffort, isModelAvailable, effortSupported, dataDir, opt, claudeDir,
  referenceEffortSupported,
} from '../hooks/lib/context.mjs';
import {
  memoryRoot, discoverFiles, tokenize, search, loadOrBuildIndex,
} from '../hooks/lib/memory-index.mjs';
import { telemetryCoverage } from './lib/coverage.mjs';
import { scanModelMismatches } from './lib/model-mismatch.mjs';
import { status as memoryVaultStatus } from './memory-vault.mjs';

const est = (s) => Math.ceil(s.length / 4);
const DATED_MODEL = /-\d{6,8}$/;

// audit.mjs computes ctx.memoryDir = memoryDirFor(target) UNCONDITIONALLY for
// every run, even `--only spawn-audit` — so this must honour
// AGENT_COMPANION_HOME_OVERRIDE (via claudeDir()) rather than raw homedir(),
// or a test invoking audit.mjs with any --only filter still reads the real
// ~/.claude/projects tree despite the override being set.
export function memoryDirFor(target) {
  const enc = target.replace(/[:\\/]/g, '-');
  const direct = join(claudeDir(), 'projects', enc, 'memory');
  if (existsSync(direct)) return direct;
  const base = join(claudeDir(), 'projects');
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
  return opt('memory_archive_prefixes', 'findings_,bugs,handoff-')
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
    const budget = opt('memory_budget_tokens', 3000);
    const cands = [
      ['project CLAUDE.md', join(ctx.target, 'CLAUDE.md')],
      ['global CLAUDE.md', join(claudeDir(), 'CLAUDE.md')],
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
        // CORRECTED (was: "opus falls back to Opus 5.5's medium default").
        // Per Claude Code's sub-agents docs, a definition with no `effort`
        // INHERITS THE ORCHESTRATING SESSION'S effort — not the model's own
        // API default, which is reached only outside any Claude Code
        // session. This is the same inheritance hazard as an unstated
        // MODEL, just on the effort axis, and applies to every
        // effort-taking model, not only opus.
        if (!fm.effort && fm.model && effortSupported(fm.model, 'high').ok) {
          findings.push(`${rel}: no effort set — inherits the orchestrating session's effort rather than any model default`);
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
      //
      // A definition pinned to an OLDER full/dated id (e.g. claude-opus-4-6)
      // still matches the current "opus" tier's broad regex, whose effort
      // list (low/medium/high/xhigh/max) is Opus 5.5's, not that older
      // model's — Opus 4.6 has no xhigh. referenceEffortSupported() checks
      // config's `referenceModels` first and returns null when the id
      // matches none, so this falls back to the tier-based check unchanged
      // for every alias and unpinned id.
      if (a.model && a.effort) {
        const sup = referenceEffortSupported(a.model, a.effort) || effortSupported(a.model, a.effort);
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
    // baseline.json has exactly ONE writer path now: stateFile('baseline.json'),
    // i.e. ctx.stateDir here and scripts/detect.mjs's own write — both durable,
    // both under the state root, so the two can no longer diverge.
    const bl = join(ctx.stateDir, 'baseline.json');
    let prev = {};
    try { if (existsSync(bl)) prev = JSON.parse(readFileSync(bl, 'utf8')); } catch { /* ignore */ }

    const findings = [];
    if (prev.version && prev.version !== version) {
      findings.push(`version changed: ${prev.version} -> ${version} - re-verify hook matchers, run the canary`);
    }
    try {
      mkdirSync(ctx.stateDir, { recursive: true });
      writeFileSync(bl, JSON.stringify({ ...prev, version }, null, 2));
    } catch { /* ignore */ }

    const unknownFile = join(ctx.telemetryDir, 'unknown-agent-types.jsonl');
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
    const f = join(ctx.telemetryDir, 'spawns.jsonl');
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
    // Rung-level effort drift: right MODEL tier, but effort below the ladder
    // rung the routing table recommended for the declared weight. `fit` from
    // evaluateFit() already folds a model mismatch and an effort mismatch
    // into one "under" verdict; this narrows to the effort-only case (model
    // alias matches fit_expected's own model) so a genuinely under-tiered
    // model is not double-counted here.
    const effortOnlyUnder = declared.filter((r) => {
      if (r.fit !== 'under' || !r.fit_expected || !r.model) return false;
      const expModel = String(r.fit_expected).split('/')[0];
      return classifyModel(r.model).alias === expModel;
    });
    if (effortOnlyUnder.length) {
      findings.push(
        `${effortOnlyUnder.length} spawn(s) ran at the right model but a lower effort than the recommended ` +
        `ladder rung (e.g. sonnet/medium spawned where the table said sonnet/high) - see fit_expected per row`,
      );
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

// --- 9. memory index ceiling ----------------------------------------------
// Claude Code's native auto-memory loader only reads the FIRST 200 lines or
// the first 25KB of MEMORY.md, whichever it hits first, and everything past
// that point is dropped SILENTLY on the next load — no error, no warning, no
// trace in the transcript. This is the same failure shape the rest of this
// plugin exists to catch (a rule believed to be in effect that quietly is
// not), just triggered by size instead of a missing link. The thresholds
// below sit a little inside the real 200-line / 25KB cliff on purpose: WARN
// fires while there is still room to trim, FAIL fires before content is
// actually being clipped rather than after.
const MEMORY_CEILING_FAIL_BYTES = 24576; // 24 KiB
const MEMORY_CEILING_FAIL_LINES = 190;
const MEMORY_CEILING_WARN_BYTES = 20480; // 20 KiB
const MEMORY_CEILING_WARN_LINES = 160;

const memoryIndexCeiling = {
  id: 'memory-index-ceiling',
  title: 'Memory index load ceiling',
  vendor: 'anthropic',
  fixable: false,
  run(ctx) {
    const root = memoryRoot();
    let files;
    try {
      files = discoverFiles(root).filter((f) => f.fileRel === 'MEMORY.md');
    } catch {
      return { status: 'skip', findings: ['could not enumerate the memory corpus'] };
    }
    if (!files.length) return { status: 'skip', findings: ['no MEMORY.md found under any project memory directory'] };

    const rows = files.map((f) => {
      let lines = 0;
      try {
        // `wc -l`-style count: a trailing newline (the common case) ends the
        // last line rather than starting an extra empty one.
        const parts = readFileSync(f.absPath, 'utf8').split(/\r?\n/);
        lines = (parts.length && parts[parts.length - 1] === '') ? parts.length - 1 : parts.length;
      } catch { /* size-only */ }
      const bytes = f.size;
      const status = (bytes >= MEMORY_CEILING_FAIL_BYTES || lines >= MEMORY_CEILING_FAIL_LINES)
        ? 'fail'
        : (bytes >= MEMORY_CEILING_WARN_BYTES || lines >= MEMORY_CEILING_WARN_LINES) ? 'warn' : 'ok';
      return {
        project: f.project,
        bytes,
        lines,
        status,
        pctBytes: +((bytes / MEMORY_CEILING_FAIL_BYTES) * 100).toFixed(1),
        pctLines: +((lines / MEMORY_CEILING_FAIL_LINES) * 100).toFixed(1),
      };
    });
    rows.sort((a, b) => b.bytes - a.bytes);

    const findings = rows.map((r) => `${r.project}: ${r.bytes}B / ${r.lines} lines`
      + ` — ${r.pctBytes}% of the ${MEMORY_CEILING_FAIL_BYTES}B cliff, ${r.pctLines}% of the ${MEMORY_CEILING_FAIL_LINES}-line cliff`
      + (r.status !== 'ok' ? ` [${r.status.toUpperCase()}]` : ''));
    const worst = rows[0];
    findings.push(`worst offender: ${worst.project} (${worst.bytes}B / ${worst.lines} lines, `
      + `${worst.pctBytes}% / ${worst.pctLines}% of the hard ceiling)`);

    const failing = rows.filter((r) => r.status === 'fail');
    const warning = rows.filter((r) => r.status === 'warn');
    return {
      status: failing.length ? 'fail' : (warning.length ? 'warn' : 'ok'),
      findings,
      data: { rows, worst },
    };
  },
};

// --- 10. memory store forks -------------------------------------------------
// The auto-memory directory is keyed by an encoding of the working-directory
// path (":\/ " -> "-"), so the SAME project reached via two different paths —
// a Windows drive letter, a WSL mount, a native Linux path — silently becomes
// two or more independent stores with no cross-link between them. Detected
// with three cheap filesystem signals only: no index, no embeddings. Strictly
// read-only and proposal-only — this check never moves or deletes a file.
function normalizedProjectKey(dirName) {
  // Windows: "<drive>--Users-<user>-<rest>".
  let m = dirName.match(/^[A-Za-z]--Users-[^-]+-(.+)$/);
  if (m) return m[1];
  // Any path that resolves through a home directory (WSL, native Linux,
  // macOS): "...-home-<user>-<rest>". Deliberately unanchored at the front —
  // WSL distro-prefix spellings vary (--wsl--Ubuntu-, --wsl-localhost-ubuntu-,
  // ...) and the home segment is the reliable landmark, not the distro name.
  m = dirName.match(/-home-[^-]+-(.+)$/);
  if (m) return m[1];
  // No recognised prefix: leave it unchanged. An unnormalised name only ever
  // matches itself — prefer missing a fork over inventing one.
  return dirName;
}

function fmtLocalDate(ms) {
  if (!ms) return '(no files)';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

const memoryStoreForks = {
  id: 'memory-store-forks',
  title: 'Memory store forks (one project, multiple paths)',
  vendor: 'anthropic',
  fixable: false,
  run(ctx) {
    const root = memoryRoot();
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return { status: 'skip', findings: ['could not read the memory projects root'] };
    }

    const stores = [];
    const now = Date.now();
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const mdir = join(root, e.name, 'memory');
      if (!existsSync(mdir)) continue;
      let files;
      try { files = readdirSync(mdir).filter((f) => f.endsWith('.md')); } catch { continue; }
      let totalBytes = 0;
      let newestMs = 0;
      let recent90d = 0;
      for (const f of files) {
        let st;
        try { st = statSync(join(mdir, f)); } catch { continue; } // unreadable: skip, don't guess
        totalBytes += st.size;
        if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
        if (now - st.mtimeMs <= NINETY_DAYS_MS) recent90d++;
      }
      stores.push({
        project: e.name,
        mdir,
        files: new Set(files),
        fileCount: files.length,
        totalBytes,
        newestMs,
        recent90d,
        key: normalizedProjectKey(e.name),
      });
    }
    if (!stores.length) return { status: 'skip', findings: ['no memory stores found under the projects root'] };

    const groups = new Map();
    for (const s of stores) {
      if (!groups.has(s.key)) groups.set(s.key, []);
      groups.get(s.key).push(s);
    }
    const forkGroups = [...groups.values()].filter((g) => g.length > 1);
    if (!forkGroups.length) {
      return { status: 'ok', findings: ['no project reached from more than one path — no forks detected'] };
    }

    const findings = [];
    const data = [];
    for (const group of forkGroups) {
      // Newest mtime is what distinguishes live from dead — a store nobody
      // has written to in months is not "smaller", it is abandoned.
      const sorted = [...group].sort((a, b) => b.newestMs - a.newestMs);
      const [live, ...dead] = sorted;
      findings.push(`FORK GROUP "${live.key}": ${group.length} stores share this project`);
      for (const s of sorted) {
        const role = s === live ? 'LIVE (newest)' : 'looks dead';
        findings.push(`  [${role}] ${s.project} — ${s.fileCount} files, ${s.totalBytes}B, `
          + `newest ${fmtLocalDate(s.newestMs)}, ${s.recent90d} file(s) touched in the last 90d`);
      }

      const groupData = { key: live.key, live: live.project, dead: [] };
      for (const d of dead) {
        const uniqueToDead = [...d.files].filter((f) => !live.files.has(f));
        const uniqueToLive = [...live.files].filter((f) => !d.files.has(f));
        const overlap = [...d.files].filter((f) => live.files.has(f));
        let identical = 0;
        let deadLarger = 0;
        let liveLarger = 0;
        const deadLargerFiles = [];
        for (const f of overlap) {
          try {
            const a = readFileSync(join(d.mdir, f));
            const b = readFileSync(join(live.mdir, f));
            if (a.equals(b)) { identical++; continue; }
            if (a.length > b.length) { deadLarger++; deadLargerFiles.push(f); } else { liveLarger++; }
          } catch { /* unreadable: leave it out rather than guess */ }
        }
        findings.push(`  ${d.project} vs live: ${uniqueToDead.length} file(s) unique to this store, `
          + `${uniqueToLive.length} unique to live; of ${overlap.length} shared: ${identical} identical, `
          + `${liveLarger} live-larger, ${deadLarger} DEAD-LARGER`);
        if (deadLargerFiles.length) {
          findings.push('    inspect before archiving — dead copy is larger, may hold content the live '
            + `store lost: ${deadLargerFiles.join(', ')}`);
        }
        groupData.dead.push({
          store: d.project,
          fileCount: d.fileCount,
          bytes: d.totalBytes,
          newest: fmtLocalDate(d.newestMs),
          uniqueToDead: uniqueToDead.length,
          uniqueToLive: uniqueToLive.length,
          overlap: overlap.length,
          identical,
          liveLarger,
          deadLarger,
          deadLargerFiles,
        });
      }
      findings.push(`  PROPOSAL (nothing moved): ${live.project} looks live; `
        + `${dead.map((d) => d.project).join(', ')} look dead. Inspect the dead-larger file(s) above by `
        + 'hand before archiving anything — memory-doctor.mjs is the precedent for a non-destructive move, '
        + 'but running it is a separate, human-approved step.');
      data.push(groupData);
    }

    return { status: 'warn', findings, data: { groups: data } };
  },
};

// --- 11. memory near-duplicates ---------------------------------------------
// Surfaces memories that may say the same thing twice, or disagree, for a
// human or a model to adjudicate. Reuses the BM25 engine in
// hooks/lib/memory-index.mjs rather than scoring similarity a second way.
//
// Calling search() once per chunk against the FULL corpus re-tokenizes every
// other chunk on every call — ~87s measured against the real ~1400-chunk
// corpus. Building a coarse inverted index once and handing search() only
// each chunk's own small candidate pool keeps the exact same scoring
// function — nothing about BM25 is reimplemented, only candidate
// generation — and drops that to ~3s.
const NEAR_DUP_THRESHOLD = 80;
const NEAR_DUP_CAP = 20;
const NEAR_DUP_SIG_TERMS = 12;
const NEAR_DUP_MAX_CANDIDATES = 200;

const memoryNearDuplicates = {
  id: 'memory-near-duplicates',
  title: 'Memory near-duplicates',
  vendor: 'anthropic',
  fixable: false,
  run(ctx) {
    const root = memoryRoot();
    let index;
    try {
      ({ index } = loadOrBuildIndex({ root, dataDirPath: dataDir(), rebuildIfStale: true }));
    } catch {
      return { status: 'skip', findings: ['could not build the memory index'] };
    }
    const chunks = (index && index.chunks) || [];
    if (chunks.length < 2) return { status: 'skip', findings: ['not enough indexed content to compare'] };

    let tokSets;
    try {
      tokSets = chunks.map((c) => new Set(tokenize(c.text)));
    } catch {
      return { status: 'skip', findings: ['could not tokenize the corpus'] };
    }
    const df = new Map();
    for (const set of tokSets) for (const t of set) df.set(t, (df.get(t) || 0) + 1);
    const postings = new Map();
    for (let i = 0; i < tokSets.length; i++) {
      for (const t of tokSets[i]) {
        if (!postings.has(t)) postings.set(t, []);
        postings.get(t).push(i);
      }
    }
    const candidatesFor = (i) => {
      const terms = [...tokSets[i]].sort((a, b) => (df.get(a) || 0) - (df.get(b) || 0)).slice(0, NEAR_DUP_SIG_TERMS);
      const seen = new Set();
      for (const t of terms) {
        for (const j of postings.get(t) || []) {
          if (j === i) continue;
          seen.add(j);
          if (seen.size >= NEAR_DUP_MAX_CANDIDATES) break;
        }
        if (seen.size >= NEAR_DUP_MAX_CANDIDATES) break;
      }
      return [...seen];
    };

    const isArchive = (f) => /(^|\/)archive\//.test(f);
    const sameFile = (a, b) => a.project === b.project && a.file === b.file;
    // A pair sharing a filename is the SAME memory living in more than one
    // place — an archive/ copy left next to its live twin, or exactly the
    // cross-store forks memory-store-forks already finds and byte-compares
    // precisely. Reporting it again here would just echo that check with a
    // fuzzier instrument; this check's job is DIFFERENT memories that may
    // overlap or disagree, so same-name-different-location pairs are left out.
    const sameNameElsewhere = (a, b) => !sameFile(a, b) && basename(a.file) === basename(b.file);

    let candidateError = false;
    const best = new Map(); // "i-j" (i<j) -> highest score seen for that pair
    for (let i = 0; i < chunks.length; i++) {
      const cand = candidatesFor(i);
      if (!cand.length) continue;
      const pool = cand.map((j) => chunks[j]);
      let hits;
      try {
        hits = search(pool, chunks[i].text, { limit: 8 });
      } catch { candidateError = true; continue; }
      for (const h of hits) {
        const j = cand[pool.indexOf(h.chunk)];
        const a = chunks[i];
        const b = chunks[j];
        if (sameFile(a, b)) continue;
        if (isArchive(a.file) && isArchive(b.file)) continue;
        if (sameNameElsewhere(a, b)) continue;
        if (h.score < NEAR_DUP_THRESHOLD) continue;
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        const prev = best.get(key);
        if (!prev || h.score > prev) best.set(key, h.score);
      }
    }
    if (candidateError && best.size === 0) {
      return { status: 'skip', findings: ['similarity search failed for every chunk'] };
    }

    const pairs = [...best.entries()]
      .map(([k, score]) => { const [i, j] = k.split('-').map(Number); return { i, j, score }; })
      .sort((a, b) => b.score - a.score);

    const findings = [
      'High lexical similarity means NEAR-DUPLICATION, not contradiction: two memories that '
      + 'disagree about the same flag or fact can score just as high as two that agree. This '
      + 'check can only say a pair is worth a human or model look — never that they contradict.',
    ];
    if (!pairs.length) {
      findings.push(`no pairs scored >= ${NEAR_DUP_THRESHOLD} across ${chunks.length} chunks — nothing to review`);
      return { status: 'ok', findings, data: { threshold: NEAR_DUP_THRESHOLD, total: 0 } };
    }

    findings.push(`${pairs.length} pair(s) scored >= ${NEAR_DUP_THRESHOLD} `
      + `(threshold tuned against this operator's real ${chunks.length}-chunk corpus); `
      + `showing the top ${Math.min(NEAR_DUP_CAP, pairs.length)}:`);
    for (const p of pairs.slice(0, NEAR_DUP_CAP)) {
      const a = chunks[p.i];
      const b = chunks[p.j];
      findings.push(`  ${p.score.toFixed(1).padStart(6)}  [${a.project}/${a.file}${a.heading ? ` > ${a.heading}` : ''}]`
        + `  <->  [${b.project}/${b.file}${b.heading ? ` > ${b.heading}` : ''}]`);
    }

    return {
      status: 'warn',
      findings,
      data: { threshold: NEAR_DUP_THRESHOLD, total: pairs.length, shown: pairs.slice(0, NEAR_DUP_CAP) },
    };
  },
};

// --- 12. telemetry coverage ------------------------------------------------
// spawns.jsonl is the guard's own account of what it saw — a guard that has
// gone silent (renamed matcher, a config flag flipped off, an exception
// before the append) produces exactly the same empty log as a quiet day.
// Transcripts are independent ground truth: every real `Agent` tool_use call
// is written there by the harness, outside this plugin's control. This check
// is not fixable — a silent guard needs a person to look at it, not a repair.
const telemetryCoverageCheck = {
  id: 'telemetry-coverage',
  title: 'Guard telemetry coverage vs. transcripts',
  vendor: 'anthropic',
  fixable: false,
  async run(ctx) {
    let result;
    try {
      result = await telemetryCoverage({ days: ctx.days || 7, partialRatio: opt('coverage_partial_ratio', 0.5) });
    } catch (e) {
      return { status: 'skip', findings: [`coverage check failed: ${e.message}`] };
    }
    const bad = result.days.filter((d) => d.status === 'silent' || d.status === 'partial');
    const findings = bad.map((d) => `${d.day}: ${d.status.toUpperCase()} — ${d.transcriptSpawns} transcript Agent spawn(s), `
      + `${d.telemetryRows} spawns.jsonl row(s)${d.partialDay ? ' (today, still in progress)' : ''}`);
    if (result.truncated) findings.push('transcript walk was truncated by the file/byte cap — coverage may be undercounted');
    return { status: bad.length ? 'warn' : 'ok', findings, data: result };
  },
};

// --- 13. brevity canary ---------------------------------------------------
// guardCanary (above) proves the spawn/delegation guards still fire. This
// proves the OTHER live-wiring path added alongside them: the reporting
// contract (hooks/lib/brevity.mjs) actually reaching a spawned agent's own
// prompt, and the standing-rules engine (hooks/lib/rules.mjs) actually
// injecting - and, just as important, actually staying silent when nothing
// matches. A feature that is installed but never wired into the prompt a
// subagent receives produces the same "nothing to report" silence as one
// that was never built, so this spawns the real hooks as child processes and
// inspects their actual stdout rather than reading config and assuming it
// is honoured.
//
// Every payload's session_id starts with "canary": isCanarySession() in
// hooks/lib/context.mjs drops any telemetry row keyed on such a session_id
// before it is ever written (appendLog, noteAgentType), so these probes can
// never inflate the very telemetry the audit (and this check) reads back -
// the same convention guardCanary relies on above, and for the same reason:
// a probe that pollutes the metric it exists to check is the failure this
// plugin exists to catch, not commit.
//
// Same env-isolation convention as guardCanary: no override is set here, so
// each hook reads the CALLER's real ~/.claude/agent-companion/config
// (brevity on/off, standing rules), exactly as it would for a live spawn.
// That is deliberate parity with guardCanary, not an oversight - but it does
// mean an operator who has genuinely turned a feature off will see this
// check report it as "not reaching a spawn", which is the literal truth for
// their configuration, not a false alarm.
const brevityCanary = {
  id: 'brevity-canary',
  title: 'Reporting contract actually reaches a spawn',
  vendor: 'anthropic',
  fixable: false,
  async run(ctx) {
    const hooks = join(ctx.pluginRoot, 'hooks');
    if (!existsSync(hooks)) return { status: 'skip', findings: ['plugin hooks directory not found'] };

    const required = [
      'spawn-guard.mjs',
      'standing-rules.mjs',
      'subagent-brevity.mjs',
      join('lib', 'brevity.mjs'),
      join('lib', 'rules.mjs'),
    ];
    const missing = required.filter((f) => !existsSync(join(hooks, f)));
    if (missing.length) return { status: 'skip', findings: [`required module(s) missing: ${missing.join(', ')}`] };

    // Read the marker straight from the module that owns it, rather than
    // hardcoding the string here - via a DYNAMIC import, not a static one, so
    // a broken or moved brevity.mjs SKIPs this one check instead of taking
    // every other check in this file down with it at module-load time (the
    // same reasoning lib/rules.mjs's own banner gives for its own dynamic
    // import of brevity.mjs).
    let CONTRACT_MARKER;
    try {
      ({ CONTRACT_MARKER } = await import(pathToFileURL(join(hooks, 'lib', 'brevity.mjs')).href));
      if (!CONTRACT_MARKER) throw new Error('CONTRACT_MARKER export is missing or empty');
    } catch (e) {
      return { status: 'skip', findings: [`could not read CONTRACT_MARKER from hooks/lib/brevity.mjs: ${e.message}`] };
    }

    const findings = [];

    const probe = (script, payload, args = []) => {
      try {
        const out = execFileSync('node', [join(hooks, script), ...args], {
          input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000,
        });
        return out.trim() ? JSON.parse(out) : null; // null: ran fine, said nothing
      } catch {
        return undefined; // did not run, or produced unparseable output
      }
    };

    // --- 1. spawn-guard.mjs: cheap-model spawn is allowed AND rewritten ----
    const spawnOut = probe('spawn-guard.mjs', {
      session_id: 'canary-brevity-spawn',
      agent_type: 'main',
      tool_input: {
        model: 'claude-haiku-4-5',
        subagent_type: 'general-purpose',
        prompt: 'canary probe for the reporting contract - deliberately unremarkable content',
      },
    });
    if (spawnOut === undefined) {
      findings.push('spawn-guard.mjs: did not run at all on the canary payload');
    } else if (spawnOut?.hookSpecificOutput?.permissionDecision !== 'allow') {
      findings.push('spawn-guard.mjs: did NOT allow a cheap-model canary spawn - expected permissionDecision "allow"');
    } else {
      const rewritten = String(spawnOut.hookSpecificOutput?.updatedInput?.prompt || '');
      if (!rewritten.includes(CONTRACT_MARKER)) {
        findings.push('spawn-guard.mjs: allowed the canary spawn but the prompt was NOT rewritten with the reporting contract - the contract is INERT: installed but never reaching a real spawn');
      }
    }

    // --- 2. standing-rules.mjs --event session-start: fires unconditionally
    const ssOut = probe('standing-rules.mjs', { session_id: 'canary-brevity-session-start' }, ['--event', 'session-start']);
    if (ssOut === undefined) {
      findings.push('standing-rules.mjs --event session-start: did not run at all');
    } else if (!ssOut?.hookSpecificOutput?.additionalContext) {
      findings.push('standing-rules.mjs --event session-start: emitted no additionalContext - the built-in session-start rules (e.g. "delegate-first", gate: null) never fired');
    }

    // --- 3. standing-rules.mjs --event user-prompt: both directions -------
    let copyablePromptThen = null;
    try {
      const { readRules } = await import(pathToFileURL(join(hooks, 'lib', 'rules.mjs')).href);
      const rule = readRules().rules.find((r) => r.id === 'copyable-prompt');
      if (rule && rule.enabled) copyablePromptThen = rule.then;
    } catch { /* handled below by the finding this produces when it stays null */ }

    if (!copyablePromptThen) {
      findings.push('standing-rules.mjs: could not read an enabled "copyable-prompt" built-in rule to probe against - skipping the user-prompt directions');
    } else {
      const matchOut = probe(
        'standing-rules.mjs',
        { session_id: 'canary-brevity-user-prompt-match', prompt: 'Please write me a prompt for onboarding a new hire.' },
        ['--event', 'user-prompt'],
      );
      if (matchOut === undefined) {
        findings.push('standing-rules.mjs --event user-prompt (matching case): did not run at all');
      } else if (!String(matchOut?.hookSpecificOutput?.additionalContext || '').includes(copyablePromptThen)) {
        findings.push("standing-rules.mjs --event user-prompt: a prompt matching the built-in \"copyable-prompt\" rule did NOT surface that rule's directive - the rule engine is not firing");
      }

      const noMatchOut = probe(
        'standing-rules.mjs',
        { session_id: 'canary-brevity-user-prompt-nomatch', prompt: 'canary marker: filler text about lunch and the weather, nothing rule-shaped here' },
        ['--event', 'user-prompt'],
      );
      if (noMatchOut === undefined) {
        findings.push('standing-rules.mjs --event user-prompt (non-matching case): did not run at all');
      } else if (noMatchOut !== null) {
        findings.push('standing-rules.mjs --event user-prompt: a prompt matching NO rule still emitted additionalContext - the rule engine is firing on everything, which is as broken as never firing');
      }
    }

    // --- 4. subagent-brevity.mjs --event start: no double-injection --------
    const alreadyHas = probe('subagent-brevity.mjs', {
      session_id: 'canary-brevity-sub-a',
      agent_id: 'canary-brevity-agent-a',
      agent_type: 'general-purpose',
      agent_prompt: `some prior brief text\n\n${CONTRACT_MARKER}\nalready injected by spawn-guard`,
    }, ['--event', 'start']);
    if (alreadyHas === undefined) {
      findings.push('subagent-brevity.mjs --event start (already-injected case): did not run at all');
    } else if (alreadyHas !== null) {
      findings.push('subagent-brevity.mjs --event start: re-injected the contract into a prompt that already had it - double-injection, paying the token cost twice');
    }

    const missingIt = probe('subagent-brevity.mjs', {
      session_id: 'canary-brevity-sub-b',
      agent_id: 'canary-brevity-agent-b',
      agent_type: 'general-purpose',
      agent_prompt: 'some prior brief text with no reporting contract in it at all',
    }, ['--event', 'start']);
    if (missingIt === undefined) {
      findings.push('subagent-brevity.mjs --event start (missing case): did not run at all');
    } else if (!String(missingIt?.hookSpecificOutput?.additionalContext || '').includes(CONTRACT_MARKER)) {
      findings.push('subagent-brevity.mjs --event start: a prompt with no reporting contract was not topped up - the self-heal path is inert');
    }

    return { status: findings.length ? 'fail' : 'ok', findings };
  },
};

// --- 14. memory vault drift --------------------------------------------
// See docs/adr/0001-memory-corpus-backup-vault.md. Not fixable from here —
// same posture as telemetry-coverage: a stale or uninitialized vault needs
// `node scripts/memory-vault.mjs sync`/`init` run by a person or the
// scheduled routine, not an automatic repair from an audit pass.
const MEMORY_VAULT_STALE_DAYS = 2; // daily cadence; one day's grace before warning
// A single 'locked' is an ordinary race between two syncs. A run of them is not.
const MEMORY_VAULT_SKIP_RUN = 2;
const memoryVaultDrift = {
  id: 'memory-vault-drift',
  title: 'Memory vault backup drift',
  vendor: 'anthropic',
  fixable: false,
  run(ctx) {
    // Read the vault's own record FIRST, before any gate. This check used to
    // open with `if (!opt('memory_vault', false)) return skip` — and it is
    // reachable only through audit.mjs, which is CLI-only, so for as long as
    // opt() could not see settings.json the one check written to notice a
    // vault that had stopped backing up skipped before it looked at anything.
    // The option still decides the verdict, but it no longer decides alone:
    // sync() now records every attempt, and a record that CONTRADICTS how the
    // option reads here is reported whichever way it resolves.
    let s;
    try {
      s = memoryVaultStatus();
    } catch (e) {
      return { status: 'skip', findings: [`could not read vault status: ${e.message}`] };
    }
    const enabled = !!s.enabled;
    const attempt = s.lastAttemptAt
      ? `last sync attempt ${s.lastAttemptAt} → ${s.lastAttemptOutcome}`
        + `${s.lastAttemptReason ? ` (${s.lastAttemptReason})` : ''}`
      : 'no sync attempt has ever been recorded';

    // The unambiguous contradiction: the option reads ON here, and the last
    // attempt was refused because it read OFF there. One option, two answers.
    // That is an option failing to reach the context that runs the sync, and
    // it cannot be a setting anyone chose — so it is reported on the first
    // audit after it happens, with no staleness window to wait out.
    if (enabled && s.lastAttemptReason === 'disabled') {
      return {
        status: 'fail',
        findings: [
          `memory_vault reads ON here but the last sync attempt was refused as disabled — ${attempt}`,
          `${s.consecutiveSkips} consecutive attempt(s) have done no work; the option is not `
            + 'reaching the context that runs the sync (a scheduled or CLI run sees no '
            + 'CLAUDE_PLUGIN_OPTION_* env vars — those exist only inside hooks)',
          s.lastSyncAt
            ? `the last sync that actually ran was ${s.lastSyncAt} (${s.runDaysAgo}d ago)`
            : 'no sync has ever actually run',
        ],
        data: s,
      };
    }

    if (!enabled) {
      // Deliberately off stays a skip — but the trace goes into the report, so
      // a vault that WAS being backed up and is now being turned away is
      // visible as something other than an absence.
      const findings = ['memory vault is disabled (memory_vault option is off)', attempt];
      if (s.lastSyncAt) {
        findings.push(`the vault has been synced before (last real run ${s.lastSyncAt}, `
          + `${s.runDaysAgo}d ago) — if that was not meant to stop, re-enable the memory_vault option`);
      }
      return { status: 'skip', findings };
    }

    if (!s.initialized) {
      return {
        status: 'warn',
        findings: [
          `vault not initialized at ${s.dir} — run: node scripts/memory-vault.mjs init`,
          attempt,
        ],
        data: s,
      };
    }
    const findings = [`${s.fileCount} file(s) tracked across ${s.projectCount} project(s) at ${s.dir}`];
    if (s.dirty) {
      findings.push('vault working tree has uncommitted changes — a previous sync may have been '
        + 'interrupted; run `node scripts/memory-vault.mjs sync` again or inspect manually');
      return { status: 'fail', findings, data: s };
    }
    if (!s.lastCommit) {
      findings.push('vault initialized but never synced — run: node scripts/memory-vault.mjs sync');
      return { status: 'warn', findings, data: s };
    }
    findings.push(`last commit ${s.staleDays}d ago: ${s.lastCommit.sha.slice(0, 12)} "${s.lastCommit.subject}"`);

    // A vault without `* -text` restores whatever core.autocrlf feels like
    // rather than what was backed up. It looks perfectly healthy until the
    // day it is restored, so the check has to say so while there is still
    // another copy of the corpus to compare against.
    if (s.byteExact === false) {
      findings.push('vault has no .gitattributes disabling line-ending conversion — a checkout can '
        + 'rewrite LF-native stores to CRLF, so restored files would not be byte-identical to what '
        + 'was backed up; run: node scripts/memory-vault.mjs init');
      return { status: 'warn', findings, data: s };
    }

    // Attempts that keep doing no work, for a reason OTHER than the option.
    // The transient case is carried in the REASON ('locked'), not the outcome
    // ('skipped'), so it is the reason that has to earn the grace.
    if (s.lastAttemptOutcome && s.lastAttemptOutcome !== 'ran'
      && (s.lastAttemptReason !== 'locked' || s.consecutiveSkips >= MEMORY_VAULT_SKIP_RUN)) {
      findings.push(`${attempt}; ${s.consecutiveSkips} consecutive attempt(s) have done no work`);
      return { status: 'warn', findings, data: s };
    }

    if (s.staleDays !== null && s.staleDays > MEMORY_VAULT_STALE_DAYS) {
      // An old last COMMIT is not by itself an old backup. A vault whose
      // corpus has not changed commits nothing, and warning on that would
      // teach the operator to ignore this check. Now that every sync that
      // runs records lastSyncAt — including the ones that find nothing to do —
      // the two can finally be told apart.
      if (s.runDaysAgo !== null && s.runDaysAgo <= MEMORY_VAULT_STALE_DAYS) {
        findings.push(`no commit in ${s.staleDays}d, but a sync ran ${s.runDaysAgo}d ago and found `
          + 'nothing to commit — the corpus is simply unchanged');
        return { status: 'ok', findings, data: s };
      }
      findings.push(`stale — more than ${MEMORY_VAULT_STALE_DAYS}d since the last sync `
        + `(${s.runDaysAgo === null ? 'no successful run has ever been recorded' : `last real run ${s.runDaysAgo}d ago`}); `
        + 'confirm the locally scheduled calibration scout is still running '
        + '(it drives this on the daily cadence)');
      return { status: 'warn', findings, data: s };
    }
    return { status: 'ok', findings, data: s };
  },
};

// --- 15. resolved-model mismatch (SPAWNING RULE 3) ------------------------
// Rules 1 and 2 of the operator-approved SPAWNING RULE (2026-09-23) are
// enforced at spawn time in hooks/spawn-guard.mjs. Rule 3 — the model a
// spawn actually ran on must match what its definition's alias resolves to
// on the build that session ran — cannot be: the SPAWNED agent's own
// transcript does not exist until after the spawn is already approved. This
// check reads it back after the fact, bounded to a recent window (default
// 48h; see scripts/lib/model-mismatch.mjs for the correlation method and its
// known limits) so it stays fast enough for a routine audit pass.
const modelResolutionMismatch = {
  id: 'model-resolution-mismatch',
  title: 'Resolved model matches definition (SPAWNING RULE 3)',
  vendor: 'anthropic',
  fixable: false,
  async run(ctx) {
    let result;
    try {
      // Deliberately NOT derived from ctx.days (defaults to 7 for the other
      // checks) — a background grep over every project's transcripts took
      // over two minutes in practice, and this check exists to be safe to
      // run routinely, not to be a full-depth report. 48h fixed, regardless
      // of --days.
      result = await scanModelMismatches({ hours: 48 });
    } catch (e) {
      return { status: 'skip', findings: [`mismatch scan failed: ${e.message}`] };
    }
    if (!result.matched && !result.mismatches.length) {
      return {
        status: 'skip',
        findings: ['no correlated spawn/transcript pairs in the scan window — nothing to compare'],
        data: result,
      };
    }
    const findings = result.mismatches.map((m) => (m.kind === 'alias_mismatch'
      ? `${m.session_id} @ ${m.at}: requested "${m.requested}" (${m.requestedAlias}) but ran on ` +
        `"${m.actual}" (${m.actualAlias}) — session build ${m.buildVersion || 'unknown'} — ${m.file}`
      : `${m.session_id} @ ${m.at}: requested "${m.requested}" resolved to a SUPERSEDED generation ` +
        `"${m.actual}" (${m.supersededBy}) — session build ${m.buildVersion || 'unknown'}` +
        `${m.belowFloor ? ' (below the alias-resolution floor: expected, but confirms the hazard is live)' : ' (at/above the floor: this should NOT still be happening)'} — ${m.file}`));
    findings.push(`${result.matched} spawn/transcript pair(s) correlated, ${result.unmatched} spawn row(s) had no matching transcript within tolerance`);
    if (result.truncated) findings.push('scan was truncated by the file/byte/time cap — some recent activity may be uncounted');
    return { status: result.mismatches.length ? 'warn' : 'ok', findings, data: result };
  },
};

export const CHECKS = [
  memoryIndex,
  instructionBudget,
  agentDefs,
  harnessDrift,
  guardCanary,
  brevityCanary,
  spawnAudit,
  pluginManifests,
  routingDoc,
  memoryIndexCeiling,
  memoryStoreForks,
  memoryNearDuplicates,
  telemetryCoverageCheck,
  memoryVaultDrift,
  modelResolutionMismatch,
];
