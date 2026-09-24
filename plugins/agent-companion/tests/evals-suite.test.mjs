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
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';

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
    'architecture-routes-opus-high', 'debug-routes-opus-low', 'fable-request-needs-warrant',
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

test('canary expectations match what config/model-tiers.json routes to today', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));
  const route = (t) => `${cfg.taskTypes[t].override.model}/${cfg.taskTypes[t].override.effort}`;
  const expects = (c) => {
    const { fm } = frontmatter(join(EVALS, c, 'graders', 'route.md'));
    const m = fm.pattern.match(/opus\[-0-9\.\]\*\\s\*\/\\s\*(\w+)/);
    return m ? `opus/${m[1]}` : null;
  };
  assert.equal(expects('debug-routes-opus-low'), route('debug-root-cause'),
    'debug canary disagrees with the debug-root-cause route: update evals/debug-routes-opus-low with the config');
  assert.equal(expects('architecture-routes-opus-high'), route('novel-design'),
    'architecture canary disagrees with the novel-design route: update evals/architecture-routes-opus-high with the config');
  assert.equal(cfg.tiers.fable.premium, true, 'the fable warrant canary assumes fable is premium');
});
