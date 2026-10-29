// The scout's decide step: Claude Code releases -> decide findings, stale scout signals ->
// decide findings, the decided mark, the short SessionStart lines, and the surface table.
// Versions are 9.x. Everything runs against a temporary state dir (makeFixture).
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, runHook, PLUGIN_ROOT } from './helpers.mjs';
import { stateFile } from '../hooks/lib/context.mjs';
import {
  slug, releaseDocId, staleDocId, decideItem, decideRelease, releaseFinding, staleEntries, staleFinding,
  buildQueue, SURFACES, CHANGES, DETAIL_MAX, DECISIONS_FILE,
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

test('item recommendations: adopt needs a concrete change; an area we use without one is watch', () => {
  const stop = decideItem(item('Fixed SubagentStop hooks running twice a minute', ['subagents', 'hooks']));
  assert.equal(stop.rec, 'adopt');
  assert.equal(stop.changes[0].file, 'hooks/hooks.json');
  assert.ok(stop.changes[0].change.length > 0, 'it says what to change');
  assert.equal(decideItem(item('updatedInput from PreToolUse hooks is now validated like Claude\'s own input', ['hooks'])).rec, 'adopt');
  // Core topic or a fix, but nothing here to change: watch.
  assert.equal(decideItem(item('Fixed hooks firing twice', ['hooks'])).rec, 'watch');
  assert.equal(decideItem(item('Fixed compaction keeping too much of a long conversation', ['compaction'])).rec, 'watch');
  assert.equal(decideItem(item('Added an effort option to the Agent tool', ['subagents', 'effort'])).rec, 'watch');
  assert.equal(decideItem(item('Removed the old hook output format', ['hooks'])).rec, 'watch', 'a breaking change with nothing to name is watched');
  assert.equal(decideItem(item('Added plugin progress', ['plugins'])).rec, 'ignore');
});

test('the change patterns match their own wording and not a neighbour', () => {
  const rec = (text, topics) => decideItem(item(text, topics)).rec;
  assert.equal(rec('Fixed the CLAUDE_CODE_AUTO_COMPACT_WINDOW=200k setting silently giving a 100K window', ['compaction']), 'adopt');
  assert.equal(rec('Fixed CLAUDE_CODE_AUTO_COMPACT_WINDOW being ignored in cloud sessions', ['compaction']), 'watch');
  assert.equal(rec('Added agent_type to the SubagentStop hook input', ['subagents', 'hooks']), 'watch');
  assert.equal(rec('Changed the desktop app to always run the main conversation\u2019s subagents in the background', ['subagents']), 'adopt', 'a typographic apostrophe');
  assert.equal(rec("Changed the desktop app to always run the main conversation's subagents in the background", ['subagents']), 'adopt');
});

test('every adopt item names the file or option and what to change; watch items name none', () => {
  const d = decideItem(item('Fixed SubagentStop hooks firing twice', ['subagents', 'hooks']));
  assert.ok(d.surfaces.length > 0);
  assert.equal(d.surfaces[0].file, 'hooks/hooks.json');
  assert.ok(d.surfaces.some((s) => s.file === 'hooks/lib/sg-finish.mjs'), 'then what the topic touches');
  assert.deepEqual(decideItem(item('Fixed hooks firing twice', ['hooks'])).changes, []);
});

test('the surface and change tables only name files that exist and options the plugin declares', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const declared = new Set(Object.keys(manifest.userConfig || manifest.options || {}));
  for (const [topic, list] of Object.entries(SURFACES)) {
    for (const s of list) {
      assert.ok(existsSync(join(PLUGIN_ROOT, s.file)), `${topic}: ${s.file} missing`);
      if (s.option) assert.ok(declared.has(s.option), `${topic}: option ${s.option} not declared`);
    }
  }
  for (const c of CHANGES) {
    assert.ok(existsSync(join(PLUGIN_ROOT, c.file)), `change ${c.match}: ${c.file} missing`);
    if (c.option) assert.ok(declared.has(c.option), `change ${c.match}: option ${c.option} not declared`);
    assert.ok(c.change && c.change.length <= 60, `change text for ${c.file} must be short`);
  }
});

test('one finding covers every adopt release of a run; it has the contract fields and a detail within the cap', () => {
  const rel = (version, text) => decideRelease({ version, items: [item(text, ['subagents', 'hooks'])] });
  const ds = [rel('9.1.1', 'Fixed SubagentStop hooks running twice'), rel('9.1.0', 'updatedInput is now validated'), rel('9.0.9', 'Fixed a hook crash')];
  assert.deepEqual(ds.map((d) => d.rec), ['adopt', 'adopt', 'watch']);
  const f = releaseFinding(ds, '2026-10-27T09:00:00.000Z');
  assert.equal(f.docId, 'findings/scout-cli-release-9-1-0-to-9-1-1');
  assert.equal(f.source, 'scout');
  assert.equal(f.expect, 'decide');
  assert.equal(f.lookedAt, null);
  assert.equal(f.useful, null);
  assert.equal(f.firstSeen, f.lastSeen);
  assert.ok(f.detail.length <= DETAIL_MAX, f.detail.length);
  assert.match(f.detail, /hooks\/hooks\.json: /);
  assert.match(f.detail, /hooks\/lib\/sg-finish\.mjs: /);
  assert.match(f.title, /^Claude Code 9\.1\.0 to 9\.1\.1: adopt/);
  assert.match(f.impact, /hooks\/lib\/sg-finish\.mjs/);
  assert.doesNotMatch(f.detail, /9\.0\.9/, 'a watch release is not in the finding');
  // A single adopt release keeps its own doc id; no adopt release gives no finding.
  assert.equal(releaseFinding([ds[0]], 'x').docId, 'findings/scout-cli-release-9-1-1');
  assert.equal(releaseFinding([ds[2]], 'x'), null);
});

test('the finding detail fits the cap with every change in the table at once, untruncated', () => {
  const all = decideRelease({ version: '9.9.9', items: CHANGES.map((c, i) => item(`placeholder ${i}`, ['hooks'])) });
  all.rec = 'adopt';
  all.changes = CHANGES.map(({ file, option, change }) => ({ file, option, change }));
  const f = releaseFinding([all], 'x');
  assert.ok(f.detail.length <= DETAIL_MAX - 5, `margin: ${f.detail.length}`);
  assert.doesNotMatch(f.detail, /\.\.\.$/);
  for (const c of CHANGES) assert.ok(f.detail.includes(c.change), c.change);
});

test('queue: one finding for the adopt releases; watch and side-topic releases are quiet and counted', () => {
  const fx = makeFixture();
  try {
    writeRelease();
    const q = buildQueue({ stateDirPath: join(fx.stateDir, 'state'), nowMs: NOW });
    assert.equal(q.releases.length, 1);
    assert.deepEqual(q.releases[0].versions, ['9.0.3']);
    assert.equal(q.releases[0].rec, 'adopt');
    assert.deepEqual(q.quiet, ['9.0.2', '9.0.1'], 'watch and side-topic releases: decided locally, no finding');
    assert.deepEqual(q.counts, { adopt: 1, watch: 1, none: 1 });
    assert.ok(existsSync(join(fx.stateDir, 'state', DECISIONS_FILE)));
    const md = readFileSync(join(fx.stateDir, 'state', DECISIONS_FILE), 'utf8');
    assert.match(md, /CHANGE: hooks\/hooks\.json/);
    assert.match(md, /## 9\.0\.1: watch/);
  } finally { fx.cleanup(); }
});

test('queue: several adopt releases give one finding that lists every version to mark', () => {
  const fx = makeFixture();
  try {
    const more = [
      { version: '9.0.5', items: [item('Fixed SubagentStop hooks running twice', ['subagents', 'hooks'])] },
      { version: '9.0.4', items: [item('updatedInput is now validated', ['hooks'])] },
      ...RELEASES,
    ];
    writeRelease({ latest: '9.0.5', releases: more });
    const q = buildQueue({ stateDirPath: join(fx.stateDir, 'state'), nowMs: NOW });
    assert.equal(q.releases.length, 1);
    assert.deepEqual(q.releases[0].versions, ['9.0.3', '9.0.4', '9.0.5']);
    assert.equal(q.releases[0].finding.docId, 'findings/scout-cli-release-9-0-3-to-9-0-5');
    assert.deepEqual(q.counts, { adopt: 3, watch: 1, none: 1 });
  } finally { fx.cleanup(); }
});

test('a release is decided only when marked; marked releases leave the queue; a failed write leaves it queued', () => {
  const fx = makeFixture();
  try {
    writeRelease();
    const dir = join(fx.stateDir, 'state');
    const before = buildQueue({ stateDirPath: dir, nowMs: NOW });
    assert.equal(before.releases.length, 1);
    // No mark yet (the store write failed): the same queue again.
    assert.equal(buildQueue({ stateDirPath: dir, nowMs: NOW }).releases.length, 1);
    assert.ok(markDecided(stateFile('release-watch.json'), ['9.0.3', '9.0.2']));
    const after = buildQueue({ stateDirPath: dir, nowMs: NOW });
    assert.deepEqual(after.releases, []);
    assert.deepEqual(after.quiet, ['9.0.1']);
    const state = JSON.parse(readFileSync(stateFile('release-watch.json'), 'utf8'));
    assert.deepEqual(state.decided.sort(), ['9.0.2', '9.0.3']);
    assert.equal(state.latest, '9.0.3', 'marking keeps the rest of the state');
  } finally { fx.cleanup(); }
});

test('markDecided reports a failed write instead of claiming success', () => {
  const fx = makeFixture();
  try {
    writeRelease();
    // The state "file" is a directory: the write cannot succeed.
    const dirAsFile = join(fx.stateDir, 'state', 'not-a-file');
    mkdirSync(dirAsFile, { recursive: true });
    assert.equal(markDecided(dirAsFile, ['9.0.3']), false);
  } finally { fx.cleanup(); }
});

test('releases at or below the installed version are not queued', () => {
  const fx = makeFixture();
  try {
    writeRelease();
    const q = buildQueue({ stateDirPath: join(fx.stateDir, 'state'), nowMs: NOW, runningVersion: '9.0.2' });
    assert.deepEqual(q.releases.map((r) => r.versions).flat(), ['9.0.3']);
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
    assert.deepEqual(q.json.releases.map((r) => r.version), ['9.0.3']);
    assert.deepEqual(q.json.quiet, ['9.0.2', '9.0.1']);
    assert.deepEqual(q.json.counts, { adopt: 1, watch: 1, none: 1 });
    assert.equal(q.json.stale.length, 1);
    assert.equal(q.json.releases[0].finding.expect, 'decide');

    const m = runScript('scripts/intake-decide.mjs', ['mark', '9.0.3', '9.0.2']);
    assert.equal(m.status, 0, m.stderr);
    assert.match(m.stdout, /decided: 9\.0\.3 9\.0\.2/);
    const q2 = runScript('scripts/intake-decide.mjs', ['queue']);
    assert.deepEqual(q2.json.releases, []);
    assert.deepEqual(q2.json.quiet, ['9.0.1']);

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
