// cache-ttl per-rung split: via views, resume rewrites, sample floor,
// experiment-project exclusion. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import {
  computeCacheTtl, computeVerdict, rungVerdict, isExperimentProject, TOO_LITTLE_DATA, RUNG_VIEWS,
  MIN_RUNG_FILES, MIN_RUNG_REQUESTS, MIN_RUNG_VIEW_GAPS, MIN_AGENT_SAVING_PCT, DONT_SET_DELTA_PCT,
} from '../scripts/lib/cache-ttl.mjs';

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const MODEL = 'claude-sonnet-5-20260101';

const user = (min, { toolResult = false, peer = false } = {}) => {
  const rec = {
    type: 'user', timestamp: at(min),
    message: { role: 'user', content: toolResult ? [{ type: 'tool_result', tool_use_id: 'tu', content: 'ok' }] : [{ type: 'text', text: 'go' }] },
  };
  if (peer) { rec.isMeta = true; rec.origin = { kind: 'peer' }; }
  return JSON.stringify(rec);
};
const asst = (min, id, { write = 0, read = 0, tool = false } = {}) => JSON.stringify({
  type: 'assistant', timestamp: at(min), requestId: id,
  message: {
    id, model: MODEL,
    usage: { input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: read, output_tokens: 5 },
    content: tool ? [{ type: 'tool_use', id: 'tu', name: 'Bash', input: {} }] : [{ type: 'text', text: 'ok' }],
  },
});

function writeAgent(root, project, id, agentType, lines) {
  const dir = join(root, project, 'sess', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType, model: 'sonnet' }));
}

// One file: cold start, a 10-min gap via a tool result, a 20-min gap via a
// SendMessage (peer), then a 90-min gap via a SendMessage (a resume after idle
// that cost a rewrite).
const rungLines = (p) => [
  user(0), asst(0, `${p}1`, { write: 1000, tool: true }),
  user(10, { toolResult: true }), asst(10, `${p}2`, { write: 1000 }),
  user(30, { peer: true }), asst(30, `${p}3`, { write: 2000 }),
  user(120, { peer: true }), asst(120, `${p}4`, { write: 2000 }),
];

test('perRung: 5-60 gaps split by via, resume rewrites counted, thin rung is TOO LITTLE DATA', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeAgent(root, 'C--Users-you-dev-proj', 'a', 'plugin:rung-a', rungLines('a'));
    const res = await computeCacheTtl({ days: 30, now: new Date(T0 + 86400000), transcriptsRoot: root });
    assert.equal(res.perRung.length, 1);
    const r = res.perRung[0];
    assert.equal(r.rung, 'plugin:rung-a');
    assert.deepEqual(r.sample, { files: 1, requests: 4, gaps: 3, gaps5to60: 2 });
    assert.deepEqual(r.gaps5to60ByVia, { message: 1, toolResult: 1 });
    // Both SendMessage gaps (20 and 90 min) outlast the 5m TTL and rewrote;
    // the tool-result gap is not a resume.
    assert.equal(r.resumeRewrites, 2);
    assert.deepEqual(Object.keys(r.views), RUNG_VIEWS);
    assert.equal(r.views.all.gaps5to60, 2);
    assert.equal(r.views.message.gaps5to60, 1);
    assert.equal(r.views.toolResult.gaps5to60, 1);
    assert.equal(r.views.meta.gaps5to60, 0);
    assert.equal(r.views.other.gaps5to60, 0);
    // conv: tool gap clamps to its own write 1000; message gap to prev prefix 1010.
    assert.equal(r.views.toolResult.convMTok, 0.001);
    assert.equal(r.views.message.convMTok, 0.00101);
    assert.equal(r.views.all.convMTok, 0.00201);
    assert.equal(r.views.all.verdict, TOO_LITTLE_DATA);
    // Views are contributions, not standalone policies: no verdict, a
    // positive contribution each, and they sum to all - baseline.
    for (const v of RUNG_VIEWS.slice(1)) assert.equal(r.views[v].verdict, undefined);
    assert.ok(r.views.message.contributionUsd > 0 && r.views.toolResult.contributionUsd > 0);
    assert.ok(r.baseline.netSavingUsd < 0, 'the baseline is the bare 2x write premium');
    const sum = RUNG_VIEWS.slice(1).reduce((t, v) => t + r.views[v].contributionUsd, 0);
    assert.ok(Math.abs(sum - (r.views.all.netSavingUsd - r.baseline.netSavingUsd)) < 1e-3, 'contributions sum to all - baseline');
    const share = RUNG_VIEWS.slice(1).reduce((t, v) => t + r.views[v].sharePct, 0);
    assert.ok(Math.abs(share - 100) < 0.05);
    assert.deepEqual(res.rungFloor, { files: MIN_RUNG_FILES, requests: MIN_RUNG_REQUESTS, viewGaps5to60: MIN_RUNG_VIEW_GAPS });
  } finally { cleanup(); }
});

test('rungVerdict: floor first, then PAYS / NEUTRAL / COSTS', () => {
  const big = { files: MIN_RUNG_FILES, requests: MIN_RUNG_REQUESTS, viewGaps: MIN_RUNG_VIEW_GAPS };
  assert.equal(rungVerdict({ ...big, deltaPct: -50 }), 'PAYS');
  assert.equal(rungVerdict({ ...big, deltaPct: -MIN_AGENT_SAVING_PCT }), 'PAYS');
  assert.equal(rungVerdict({ ...big, deltaPct: 0 }), 'NEUTRAL');
  assert.equal(rungVerdict({ ...big, deltaPct: DONT_SET_DELTA_PCT }), 'COSTS');
  assert.equal(rungVerdict({ ...big, files: MIN_RUNG_FILES - 1, deltaPct: -50 }), TOO_LITTLE_DATA);
  assert.equal(rungVerdict({ ...big, requests: MIN_RUNG_REQUESTS - 1, deltaPct: -50 }), TOO_LITTLE_DATA);
  assert.equal(rungVerdict({ ...big, viewGaps: MIN_RUNG_VIEW_GAPS - 1, deltaPct: -50 }), TOO_LITTLE_DATA);
});

test('isExperimentProject: bench prefixes and projects in the system temp dir; real repos named temp/tmp are kept', () => {
  const tmp = 'C:\\Users\\you\\AppData\\Local\\Temp';
  assert.equal(isExperimentProject('C--Users-you-AppData-Local-Temp-bench-x-y', { tmp }), true);
  assert.equal(isExperimentProject('C--Users-you-AppData-Local-Temp-ttl-exp-1', { tmp }), true);
  assert.equal(isExperimentProject('-tmp-whatever', { tmp: '/tmp' }), true);
  assert.equal(isExperimentProject('C--Users-you-dev-proj', { tmp }), false);
  assert.equal(isExperimentProject('C--Users-you-dev-template-tools', { tmp }), false);
  assert.equal(isExperimentProject('C--Users-you-dev-temp-tools', { tmp }), false);
  assert.equal(isExperimentProject('C--Users-you-dev-my-tmp-app', { tmp }), false);
  assert.equal(isExperimentProject('-home-you-dev-tmp-app', { tmp: '/tmp' }), false);
});

test('computeVerdict: a per-agent 1h candidate below the per-rung floor reads too little data, not a recommendation', () => {
  const row = (label, requests, deltaPct) => ({
    label, requests, band560Requests: 0, writeMTok: 1, convMTok: 0, convOverWritePct: 0,
    breakEvenPct: 39.5, costToday: 100, cost1h: 100 * (1 + deltaPct / 100), deltaPct,
  });
  const args = {
    perModel: [row('sonnet-5', 5000, 0.2)],
    perAgentModel: [row('widget-thin → sonnet-5', 600, -8), row('widget-fat → sonnet-5', 5000, -8)],
    totals: { costToday: 1000, deltaPct: 0.2 },
    policy: { opusFableOnlyDeltaPct: -1 },
    rungSamples: new Map([
      ['widget-thin', { files: 3, requests: 600, gaps: 20, gaps5to60: MIN_RUNG_VIEW_GAPS - 1 }],
      ['widget-fat', { files: MIN_RUNG_FILES, requests: 5000, gaps: 200, gaps5to60: MIN_RUNG_VIEW_GAPS }],
    ]),
  };
  const v = computeVerdict(args);
  assert.match(v.text, /experimental: \{ cacheTtl: "1h" \} on: widget-fat/);
  assert.match(v.text, /too little data for: widget-thin → sonnet-5/);
  assert.doesNotMatch(v.text, /on: [^(]*widget-thin/);
  const only = computeVerdict({ ...args, perAgentModel: [args.perAgentModel[0]] });
  assert.match(only.text, /no named agent definition clears/);
  assert.match(only.text, /too little data for: widget-thin/);
});

test('experiment projects are excluded by default and counted with includeExperiments', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeAgent(root, 'C--Users-you-dev-proj', 'a', 'rung-a', rungLines('a'));
    writeAgent(root, 'C--Users-you-AppData-Local-Temp-exp', 'b', 'rung-b', rungLines('b'));
    writeAgent(root, 'C--Users-you-dev-temp-tools', 'c', 'rung-c', rungLines('c'));
    const opts = { days: 30, now: new Date(T0 + 86400000), transcriptsRoot: root, tmp: 'C:\\Users\\you\\AppData\\Local\\Temp' };
    const def = await computeCacheTtl(opts);
    assert.deepEqual(def.perRung.map((r) => r.rung), ['rung-a', 'rung-c'], 'a real repo named temp-tools is kept');
    assert.deepEqual(def.experimentProjects, { included: false, excludedProjects: 1 });
    assert.equal(def.subagentRequestsScanned, 8);
    const all = await computeCacheTtl({ ...opts, includeExperiments: true });
    assert.deepEqual(all.perRung.map((r) => r.rung), ['rung-a', 'rung-b', 'rung-c']);
    assert.equal(all.subagentRequestsScanned, 12);
  } finally { cleanup(); }
});

test('days is honoured: requests before the window are left out of perRung', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeAgent(root, 'C--Users-you-dev-proj', 'a', 'rung-a', rungLines('a'));
    const res = await computeCacheTtl({ days: 1, now: new Date(T0 + 3 * 86400000), transcriptsRoot: root });
    assert.equal(res.perRung.every((r) => r.sample.requests === 0), true);
  } finally { cleanup(); }
});
