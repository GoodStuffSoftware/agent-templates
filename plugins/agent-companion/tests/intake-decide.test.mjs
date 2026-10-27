// The scout's decide step: Claude Code releases -> decide findings, stale scout signals ->
// decide findings, the decided mark, the short SessionStart lines, and the surface table.
// Versions are 9.x. Everything runs against a temporary state dir (makeFixture).
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, runHook, PLUGIN_ROOT } from './helpers.mjs';
import { stateFile } from '../hooks/lib/context.mjs';
import {
  slug, releaseDocId, staleDocId, decideItem, decideRelease, releaseFinding, staleEntries, staleFinding,
  buildQueue, SURFACES, DETAIL_MAX, DECISIONS_FILE,
} from '../scripts/lib/intake-decide.mjs';
import { undecidedOf, markDecided } from '../scripts/lib/release-watch.mjs';
import { triageLine, ageDaysOf } from '../scripts/lib/scout-handoff.mjs';

const NOW = Date.parse('2026-10-27T09:00:00Z');
const item = (text, topics) => ({ text, topics });

const RELEASES = [
  { version: '9.0.3', items: [item('Fixed SubagentStop hooks firing twice a minute per running subagent', ['subagents', 'hooks'])] },
  { version: '9.0.2', items: [item('Added a plugin install progress line', ['plugins'])] },
  { version: '9.0.1', items: [item('Subagents now get MCP tools from servers that connect late', ['subagents'])] },
  { version: '9.0.0', items: [] },
];

function writeRelease(extra = {}) {
  writeFileSync(stateFile('release-watch.json'), JSON.stringify({ installedAtCheck: '8.9.0', latest: '9.0.3', releases: RELEASES, ...extra }));
}

const unackedEntry = (kind, firstDay, extra = {}) => ({ kind, days: 3, firstDay, count: 2, open: 2, actionable: true, detail: 'x', repeating: true, ...extra });
function writeDelta(entries, checkedAt = '2026-10-27T08:23:00Z') {
  writeFileSync(stateFile('scout-delta.json'), JSON.stringify({ checkedAt, evaluatedAt: checkedAt, unacknowledged: entries }));
}

// ---------- ids and the slug rule ---------------------------------------------

test('doc ids follow the store contract slug rule', () => {
  assert.equal(slug('Cli Release 2.1.304'), 'cli-release-2-1-304');
  assert.equal(slug('a__b..c'), 'a-b-c');
  assert.equal(slug('x'.repeat(80)).length, 60);
  assert.equal(releaseDocId('2.1.304'), 'findings/scout-cli-release-2-1-304');
  assert.equal(staleDocId('project_agent_drift'), 'findings/scout-decide-project-agent-drift');
});

// ---------- release decisions ---------------------------------------------------

test('item recommendations: fix on a core topic adopts, a core feature watches, a side feature is ignored', () => {
  assert.equal(decideItem(item('Fixed hooks firing twice', ['hooks'])).rec, 'adopt');
  assert.equal(decideItem(item('Added an effort option to the Agent tool', ['subagents', 'effort'])).rec, 'watch');
  assert.equal(decideItem(item('Added plugin progress', ['plugins'])).rec, 'ignore');
  assert.equal(decideItem(item('Removed the old hook output format', ['hooks'])).rec, 'adopt', 'a breaking change is adopted and verified');
});

test('every item names the file or option it could change', () => {
  const d = decideItem(item('Fixed SubagentStop hooks firing twice', ['subagents', 'hooks']));
  assert.ok(d.surfaces.length > 0);
  assert.equal(d.surfaces[0].file, 'hooks/subagent-context.mjs', 'a SubagentStop item points at the hook count and telemetry');
  assert.ok(d.surfaces.some((s) => s.file === 'hooks/spawn-guard.mjs'));
});

test('the surface table only names files that exist and options the plugin declares', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const declared = new Set(Object.keys(manifest.userConfig || manifest.options || {}));
  for (const [topic, list] of Object.entries(SURFACES)) {
    for (const s of list) {
      assert.ok(existsSync(join(PLUGIN_ROOT, s.file)), `${topic}: ${s.file} missing`);
      if (s.option) assert.ok(declared.has(s.option), `${topic}: option ${s.option} not declared`);
    }
  }
});

test('a release finding has the contract fields, expect decide, and a detail within the cap', () => {
  const big = { version: '9.1.0', items: Array.from({ length: 9 }, (_, i) => item(`Fixed subagent problem number ${i} with a deliberately long description of what went wrong inside the harness`, ['subagents'])) };
  const f = releaseFinding(decideRelease(big), '2026-10-27T09:00:00.000Z');
  assert.equal(f.docId, 'findings/scout-cli-release-9-1-0');
  assert.equal(f.source, 'scout');
  assert.equal(f.expect, 'decide');
  assert.equal(f.lookedAt, null);
  assert.equal(f.useful, null);
  assert.equal(f.firstSeen, f.lastSeen);
  assert.ok(f.detail.length <= DETAIL_MAX, f.detail.length);
  assert.match(f.detail, /Recommend adopt/);
  assert.match(f.title, /^Claude Code 9\.1\.0: adopt/);
  assert.match(f.impact, /hooks\/spawn-guard\.mjs/);
});

test('queue: unseen releases produce findings on the first run, side-topic and empty releases do not', () => {
  const fx = makeFixture();
  try {
    writeRelease();
    const q = buildQueue({ stateDirPath: join(fx.stateDir, 'state'), nowMs: NOW });
    assert.deepEqual(q.releases.map((r) => r.version), ['9.0.3', '9.0.1']);
    assert.deepEqual(q.releases.map((r) => r.rec), ['adopt', 'watch']);
    assert.deepEqual(q.quiet, ['9.0.2'], 'nothing touches us: decided locally, no finding');
    assert.ok(existsSync(join(fx.stateDir, 'state', DECISIONS_FILE)));
    assert.match(readFileSync(join(fx.stateDir, 'state', DECISIONS_FILE), 'utf8'), /could change: hooks\/subagent-context\.mjs/);
  } finally { fx.cleanup(); }
});

test('a release is decided only when marked; marked releases leave the queue; a failed write leaves it queued', () => {
  const fx = makeFixture();
  try {
    writeRelease();
    const dir = join(fx.stateDir, 'state');
    const before = buildQueue({ stateDirPath: dir, nowMs: NOW });
    assert.equal(before.releases.length, 2);
    // No mark yet (the store write failed): the same queue again.
    assert.equal(buildQueue({ stateDirPath: dir, nowMs: NOW }).releases.length, 2);
    assert.ok(markDecided(stateFile('release-watch.json'), ['9.0.3', '9.0.2']));
    const after = buildQueue({ stateDirPath: dir, nowMs: NOW });
    assert.deepEqual(after.releases.map((r) => r.version), ['9.0.1']);
    assert.deepEqual(after.quiet, []);
    const state = JSON.parse(readFileSync(stateFile('release-watch.json'), 'utf8'));
    assert.deepEqual(state.decided.sort(), ['9.0.2', '9.0.3']);
    assert.equal(state.latest, '9.0.3', 'marking keeps the rest of the state');
  } finally { fx.cleanup(); }
});

test('releases at or below the installed version are not queued', () => {
  const fx = makeFixture();
  try {
    writeRelease();
    const q = buildQueue({ stateDirPath: join(fx.stateDir, 'state'), nowMs: NOW, runningVersion: '9.0.2' });
    assert.deepEqual(q.releases.map((r) => r.version), ['9.0.3']);
    assert.deepEqual(undecidedOf({ releases: RELEASES }, '9.0.1').map((r) => r.version), ['9.0.3', '9.0.2']);
  } finally { fx.cleanup(); }
});

// ---------- stale signals --------------------------------------------------------

test('stale: unacknowledged past 7 days is a decide finding; exactly 7 days is not', () => {
  const view = {
    checkedAt: '2026-10-27T08:23:00Z',
    unacknowledged: [
      unackedEntry('project_agent_drift', '2026-10-04'),
      unackedEntry('budget_notices', '2026-10-20', { actionable: false }), // 7 days
      unackedEntry('spawn_activity', '2026-10-19', { actionable: false }), // 8 days
      unackedEntry('cli_release_available', '2026-09-01'), // has its own decide step
    ],
  };
  const e = staleEntries(view, { nowMs: NOW });
  assert.deepEqual(e.map((x) => x.kind), ['project_agent_drift', 'spawn_activity']);
  assert.equal(e[0].ageDays, 23);
  const f = staleFinding(e[0], '2026-10-27T09:00:00.000Z');
  assert.equal(f.docId, 'findings/scout-decide-project-agent-drift');
  assert.equal(f.expect, 'decide');
  assert.match(f.detail, /Open since 2026-10-04/);
  assert.match(f.detail, /fix it/);
  assert.match(f.detail, /ack with a reason/);
  assert.match(f.detail, /retire the detector/);
  assert.ok(f.detail.length <= DETAIL_MAX);
  const info = staleFinding(e[1], 'x');
  assert.match(info.detail, /retire the detector \(add the kind to scout_suppress\)/, 'a volume reading is recommended for retirement');
});

test('stale: an old delta file (scout did not run) and suppressed kinds produce nothing', () => {
  const view = { checkedAt: '2026-10-20T08:00:00Z', unacknowledged: [unackedEntry('project_agent_drift', '2026-10-01')] };
  assert.deepEqual(staleEntries(view, { nowMs: NOW }), []);
  const fresh = { checkedAt: '2026-10-27T08:00:00Z', unacknowledged: [unackedEntry('project_agent_drift', '2026-10-01')] };
  assert.deepEqual(staleEntries(fresh, { nowMs: NOW, skipKinds: ['project_agent_drift'] }), []);
  assert.deepEqual(staleEntries(null, { nowMs: NOW }), []);
  assert.equal(ageDaysOf({ firstDay: 'garbage' }, '2026-10-27T00:00:00Z'), null);
});

test('queue reads scout-delta.json for stale kinds and notes a missing one', () => {
  const fx = makeFixture();
  try {
    const dir = join(fx.stateDir, 'state');
    assert.match(buildQueue({ stateDirPath: dir, nowMs: NOW }).notes.join(' '), /no scout-delta\.json/);
    writeDelta([unackedEntry('decision_review_due', '2026-10-10')]);
    const q = buildQueue({ stateDirPath: dir, nowMs: NOW });
    assert.deepEqual(q.stale.map((s) => s.kind), ['decision_review_due']);
    assert.equal(q.stale[0].ageDays, 17);
  } finally { fx.cleanup(); }
});

// ---------- the CLI ----------------------------------------------------------------

test('CLI: queue prints findings and mark records decided; bad usage exits 2', () => {
  const fx = makeFixture();
  try {
    writeRelease();
    writeDelta([unackedEntry('project_agent_drift', '2026-10-04')], new Date().toISOString());
    const q = runScript('scripts/intake-decide.mjs', ['queue']);
    assert.equal(q.status, 0, q.stderr);
    assert.deepEqual(q.json.releases.map((r) => r.version), ['9.0.3', '9.0.1']);
    assert.deepEqual(q.json.quiet, ['9.0.2']);
    assert.equal(q.json.stale.length, 1);
    assert.equal(q.json.releases[0].finding.expect, 'decide');

    const m = runScript('scripts/intake-decide.mjs', ['mark', '9.0.3', '9.0.2']);
    assert.equal(m.status, 0, m.stderr);
    assert.match(m.stdout, /decided: 9\.0\.3 9\.0\.2/);
    const q2 = runScript('scripts/intake-decide.mjs', ['queue']);
    assert.deepEqual(q2.json.releases.map((r) => r.version), ['9.0.1']);

    assert.equal(runScript('scripts/intake-decide.mjs', ['mark', 'latest']).status, 2);
    assert.equal(runScript('scripts/intake-decide.mjs', ['nope']).status, 2);
  } finally { fx.cleanup(); }
});

test('CLI: release_watch off or the release kind suppressed queues no release findings', () => {
  const fx = makeFixture();
  try {
    writeRelease();
    const off = runScript('scripts/intake-decide.mjs', ['queue'], { env: { CLAUDE_PLUGIN_OPTION_RELEASE_WATCH: 'false' } });
    assert.deepEqual(off.json.releases, []);
    const sup = runScript('scripts/intake-decide.mjs', ['queue'], { env: { CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'cli_release_available' } });
    assert.deepEqual(sup.json.releases, []);
  } finally { fx.cleanup(); }
});

// ---------- SessionStart lines stay short and point to the brief ----------------

test('triage line: signals open past 7 days move to the brief and are not listed', () => {
  const view = {
    checkedAt: '2026-10-27T08:23:00Z', evaluatedAt: '2026-10-27T09:00:00Z',
    unacknowledged: [
      unackedEntry('project_agent_drift', '2026-10-04', { days: 22 }),
      unackedEntry('session_churn', '2026-10-25', { days: 3 }),
    ],
  };
  const lines = triageLine(view, { mdPath: 'p', ackHint: 'h' }).split('\n');
  assert.match(lines[0], /Scout triage: 1 unacknowledged signal\(s\): session_churn \(day 3, x2\); 1 open over 7 days: decision in the morning brief/);
  assert.doesNotMatch(lines[0], /project_agent_drift/);

  const allStale = { ...view, unacknowledged: [view.unacknowledged[0]] };
  const only = triageLine(allStale, { mdPath: 'p', ackHint: 'h' }).split('\n');
  assert.match(only[0], /Scout triage: 1 open over 7 days: decision in the morning brief\. Delta: p/);
  assert.doesNotMatch(only[0], /project_agent_drift/);
});

test('release line at session start: one short line that points to the brief', () => {
  const fx = makeFixture();
  try {
    writeRelease({ installedAtCheck: '8.9.0' });
    const res = runHook('hooks/scout-surface.mjs', { session_id: 's-main', cwd: fx.dir }, { cwd: fx.dir });
    const ctx = res.json?.hookSpecificOutput?.additionalContext || '';
    const line = ctx.split('\n').find((l) => l.includes('Claude Code 9.0.3'));
    assert.ok(line, ctx);
    assert.match(line, /morning brief/);
    assert.doesNotMatch(line, /subagents, hooks, cache/, 'no topic list');
    assert.ok(line.length < 260, line.length);
  } finally { fx.cleanup(); }
});
