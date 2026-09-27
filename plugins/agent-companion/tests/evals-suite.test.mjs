// Static checks on the routing eval suite (evals/, run by `claude plugin
// eval`, docs/BENCHMARK.md "Routing eval suite"). Running the suite costs
// real model calls, so it is never run here. What IS checked, for free:
//   - every case has a prompt.md whose frontmatter uses only documented keys,
//     and graders whose type is one of the documented six;
//   - the negative trigger is scored in both arms (arm: both, min/max 0);
//   - the canaries still expect what config/model-tiers.json actually routes
//     to, so a routing change that would silently flip a canary fails here
//     first, telling you to update the eval with the config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PLUGIN_ROOT } from './helpers.mjs';
import { resolveRoute } from '../hooks/lib/context.mjs';
import { checkGraders, syncGraders, graderFor } from '../scripts/sync-eval-graders.mjs';

const EVALS = join(PLUGIN_ROOT, 'evals');
const PROMPT_KEYS = new Set(['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome', 'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'append_system_prompt', 'env']);
const GRADER_TYPES = new Set(['regex', 'tool_used', 'tool_order', 'file_exists', 'llm', 'baseline']);

function frontmatter(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  assert.ok(m, `${file}: missing frontmatter`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    assert.ok(kv, `${file}: unparseable frontmatter line: ${line}`);
    fm[kv[1]] = kv[2].replace(/^'(.*)'$/, '$1');
  }
  return { fm, body: m[2] };
}

const cases = existsSync(EVALS)
  ? readdirSync(EVALS).filter((d) => d !== 'results' && statSync(join(EVALS, d)).isDirectory())
  : [];

test('the routing eval suite exists with its five canaries', () => {
  assert.deepEqual(cases.sort(), [
    'fable-request-needs-warrant', 'route-debug-root-cause', 'route-novel-design',
    'trivial-read-not-fable', 'unrelated-request-no-routing',
  ]);
});

test('every case: documented prompt.md keys, graders of a documented type', () => {
  for (const c of cases) {
    const { fm, body } = frontmatter(join(EVALS, c, 'prompt.md'));
    for (const k of Object.keys(fm)) assert.ok(PROMPT_KEYS.has(k), `${c}/prompt.md: unknown frontmatter key "${k}" (an unknown key is an error)`);
    assert.ok(body.trim().length > 20, `${c}: prompt body is empty`);
    const graders = readdirSync(join(EVALS, c, 'graders')).filter((f) => f.endsWith('.md'));
    assert.ok(graders.length >= 2, `${c}: needs a result grader and a how-it-got-there grader`);
    for (const g of graders) {
      const { fm: gfm } = frontmatter(join(EVALS, c, 'graders', g));
      assert.ok(GRADER_TYPES.has(gfm.type), `${c}/${g}: unknown grader type ${gfm.type}`);
      if (gfm.type === 'regex') {
        assert.doesNotThrow(() => new RegExp(gfm.pattern, gfm.flags || ''), `${c}/${g}: invalid regex`);
        assert.doesNotMatch(gfm.pattern, /\(\?i\)/, 'inline (?i) is unsupported; use flags: i');
      }
    }
  }
});

test('negative trigger is scored in BOTH arms (two-arm fairness rule)', () => {
  const { fm } = frontmatter(join(EVALS, 'unrelated-request-no-routing', 'graders', 'no-routing-skill.md'));
  assert.equal(fm.type, 'tool_used');
  assert.equal(fm.tool, 'Skill');
  assert.equal(fm.arm, 'both');
  assert.equal(fm.min, '0');
  assert.equal(fm.max, '0');
});

test('route canaries are keyed by task type and their graders agree with the table', () => {
  // graders/route.md is GENERATED (scripts/sync-eval-graders.mjs); this fails
  // when the table moved and the graders were not regenerated.
  const results = checkGraders();
  assert.deepEqual(results.map((r) => r.type).sort(), ['debug-root-cause', 'novel-design']);
  for (const r of results) {
    assert.ok(r.ok, `evals/${r.dir}/graders/route.md disagrees with the table's ${r.type} route (${r.route}): run node scripts/sync-eval-graders.mjs`);
    const want = resolveRoute({ type: r.type, profile: false });
    const { fm } = frontmatter(join(EVALS, r.dir, 'graders', 'route.md'));
    const re = new RegExp(fm.pattern, fm.flags || '');
    assert.match(`ROUTE: ${want.model}/${want.effort}`, re, 'the generated pattern accepts the table route');
    assert.doesNotMatch('ROUTE: fable/max', re);
  }
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));
  assert.equal(cfg.tiers.fable.premium, true, 'the fable warrant canary assumes fable is premium');
});

test('a hand-edited grader that disagrees with the table fails the check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-evals-'));
  try {
    mkdirSync(join(dir, 'route-debug-root-cause', 'graders'), { recursive: true });
    const f = join(dir, 'route-debug-root-cause', 'graders', 'route.md');
    writeFileSync(f, graderFor('debug-root-cause').text.replace(/opus/g, 'sonnet'));
    assert.equal(checkGraders(dir)[0].ok, false);
    assert.deepEqual(syncGraders(dir), ['route-debug-root-cause']);
    assert.equal(checkGraders(dir)[0].ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
