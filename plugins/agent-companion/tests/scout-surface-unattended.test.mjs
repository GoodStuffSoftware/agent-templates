// 0.31.18 assembly: the unattended guard of batch 5b (usage summary, daily checkup line) also covers the
// release line (markSeen) and the decision-register flag line of hooks/scout-surface.mjs. An unattended
// session (CLAUDE_CODE_SESSION_ATTENDED=0 here; the other reasons share unattendedReason) is neither shown
// the line nor marks it seen, so the next attended session still gets it.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { stateFile } from '../hooks/lib/context.mjs';
import { registerPath, emptyState, writeState, readState, scanChangelog } from '../scripts/lib/decision-register.mjs';

const HOOK = 'hooks/scout-surface.mjs';
const NOW = '2026-10-12T12:00:00Z';

function go(fx, env = {}) {
  const res = runHook(HOOK, { session_id: 's-un', cwd: fx.dir }, {
    cwd: fx.dir, env: { AGENT_COMPANION_FAKE_NOW: NOW, AGENT_COMPANION_SESSIONS_DIR: join(fx.dir, 'no-sessions'), ...env },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.json?.hookSpecificOutput?.additionalContext || '';
}

test('release line: an unattended session neither shows it nor marks the versions seen', () => {
  const fx = makeFixture();
  try {
    const f = stateFile('release-watch.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ installedAtCheck: '9.0.0', latest: '9.0.3', checkedAt: NOW, source: 'test', seen: [], releases: [{ version: '9.0.3', items: ['Fixed a hooks bug'] }] }));
    const before = readFileSync(f, 'utf8');
    const quiet = go(fx, { CLAUDE_CODE_SESSION_ATTENDED: '0' });
    assert.doesNotMatch(quiet, /Claude Code 9\.0\.3 is out/);
    assert.equal(readFileSync(f, 'utf8'), before, 'the release state is untouched');
    const attended = go(fx);
    assert.match(attended, /Claude Code 9\.0\.3 is out/, 'the next attended session still gets it');
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).seen, ['9.0.3']);
  } finally { fx.cleanup(); }
});

test('register flag line: an unattended session neither shows it nor marks it surfaced', () => {
  const fx = makeFixture();
  try {
    const reg = {
      schema: 'agent-companion/decision-register', version: 1,
      decisions: [{
        id: 'cache-price', title: 'Cost model v1', status: 'active', decided: '2026-10-01',
        decision: 'Priced tokens carry a cost multiplier.', reverse: 'Remove the multiplier.',
        premises: [{ id: 'p1', text: 'Cache reads cost $1.00 per million.', label: 'M' }],
        triggers: [{ id: 'price-change', premise: 'p1', kind: 'changelog', sinceVersion: '2.1.295', flags: 'i', pattern: 'cache reads? at \\$[0-9.]+' }],
      }],
    };
    mkdirSync(dirname(registerPath()), { recursive: true });
    writeFileSync(registerPath(), JSON.stringify(reg));
    const st = emptyState();
    scanChangelog([{ version: '2.1.300', items: ['Updated the cost figures to price cache reads at $0.50 per million tokens'] }], reg, st, { nowT: Date.parse('2026-10-12T10:00:00Z') });
    writeState(st);
    const quiet = go(fx, { CLAUDE_CODE_SESSION_ATTENDED: '0' });
    assert.doesNotMatch(quiet, /Decision review due/);
    assert.deepEqual(readState().surfaced, [], 'not marked surfaced');
    const attended = go(fx);
    assert.match(attended, /Decision review due: Cost model v1/);
    assert.deepEqual(readState().surfaced, ['cache-price/price-change@2.1.300']);
  } finally { fx.cleanup(); }
});
