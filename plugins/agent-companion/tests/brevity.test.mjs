// Tests for hooks/lib/brevity.mjs (pure functions + config I/O) and
// hooks/subagent-brevity.mjs (the SubagentStart/SubagentStop hook).
//
// The two things this suite exists to catch a regression of, per the spec:
//   1. The per-agent override is BIDIRECTIONAL — 'on' beats a global 'off',
//      'off' beats a global 'on'. A "global off mutes everything"
//      implementation must fail these tests loudly.
//   2. SubagentStart must NEVER double-inject: when the marker is already in
//      agent_prompt, nothing is emitted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import {
  CONTRACT_MARKER, PEER_MARKER,
  readBrevityConfig, writeBrevityConfig, resolveBrevity, buildContract, brevityConfigPath,
} from '../hooks/lib/brevity.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';

// Save/restore a set of env vars around a synchronous callback — used for the
// CLAUDE_PLUGIN_OPTION_* vars that opt() reads directly, so one test's
// override can never leak into the next.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// --- 1. Default: no config file, no env -------------------------------------
test('default: contract ON, source option, buildContract carries the marker', () => {
  const { cleanup } = makeFixture();
  try {
    const res = resolveBrevity('general-purpose');
    assert.equal(res.on, true);
    assert.equal(res.source, 'option');

    const text = buildContract('general-purpose');
    assert.ok(text.includes(CONTRACT_MARKER), `expected CONTRACT_MARKER in: ${text}`);
  } finally {
    cleanup();
  }
});

// --- 2. Global option off, no config file -----------------------------------
test('CLAUDE_PLUGIN_OPTION_BREVITY=false with no config file: contract OFF, peer line only', () => {
  const { cleanup } = makeFixture();
  try {
    withEnv({ CLAUDE_PLUGIN_OPTION_BREVITY: 'false' }, () => {
      const res = resolveBrevity(null);
      assert.equal(res.on, false);
      assert.equal(res.source, 'option');

      const text = buildContract(null);
      assert.ok(text.includes(PEER_MARKER), `expected PEER_MARKER in: ${text}`);
      assert.ok(!text.includes(CONTRACT_MARKER), `did not expect CONTRACT_MARKER in: ${text}`);
    });
  } finally {
    cleanup();
  }
});

// --- 3. Both brevity and brevity_peer off -----------------------------------
test('brevity and brevity_peer both off: buildContract returns empty string', () => {
  const { cleanup } = makeFixture();
  try {
    withEnv({ CLAUDE_PLUGIN_OPTION_BREVITY: 'false', CLAUDE_PLUGIN_OPTION_BREVITY_PEER: 'false' }, () => {
      assert.equal(buildContract(null), '');
      assert.equal(buildContract('general-purpose'), '');
    });
  } finally {
    cleanup();
  }
});

// --- 4. Per-agent ON beats global OFF (bidirectional, direction A) ---------
test('per-agent ON beats global OFF', () => {
  const { cleanup } = makeFixture();
  try {
    assert.equal(writeBrevityConfig({ version: 1, global: 'off', agents: { Explore: 'on' } }), true);

    const explore = resolveBrevity('Explore');
    assert.equal(explore.on, true, 'per-agent on must win over a global off');
    assert.equal(explore.source, 'agent');

    const other = resolveBrevity('general-purpose');
    assert.equal(other.on, false, 'an unmatched agent type must still see the global off');
    assert.equal(other.source, 'file');
  } finally {
    cleanup();
  }
});

// --- 5. Per-agent OFF beats global ON (bidirectional, direction B) ---------
test('per-agent OFF beats global ON', () => {
  const { cleanup } = makeFixture();
  try {
    assert.equal(writeBrevityConfig({ version: 1, global: 'on', agents: { Explore: 'off' } }), true);

    const explore = resolveBrevity('Explore');
    assert.equal(explore.on, false, 'per-agent off must win over a global on');
    assert.equal(explore.source, 'agent');

    const other = resolveBrevity('general-purpose');
    assert.equal(other.on, true, 'an unmatched agent type must still see the global on');
    assert.equal(other.source, 'file');
  } finally {
    cleanup();
  }
});

// --- 6. Case-insensitive agent key matching --------------------------------
test('agent key matching is case-insensitive', () => {
  const { cleanup } = makeFixture();
  try {
    assert.equal(writeBrevityConfig({ version: 1, global: null, agents: { explore: 'off' } }), true);
    const res = resolveBrevity('Explore');
    assert.equal(res.on, false);
    assert.equal(res.source, 'agent');
  } finally {
    cleanup();
  }
});

// --- 7. Corrupt brevity.json -------------------------------------------------
test('corrupt brevity.json falls back to the option default without throwing', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(brevityConfigPath(), '{{{');
    assert.doesNotThrow(() => {
      const res = resolveBrevity('general-purpose');
      assert.equal(res.on, true); // default option is true, no env override in this test
      assert.equal(res.source, 'option');
    });
    assert.doesNotThrow(() => readBrevityConfig());
  } finally {
    cleanup();
  }
});

// --- 8. SubagentStart: never double-inject ----------------------------------
test('subagent-brevity --event start: marker already present -> empty stdout', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-brevity-start-1',
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
      agent_prompt: `Do the thing.\n\n${CONTRACT_MARKER}\nalready injected`,
      transcript_path: join(dir, 'transcript.jsonl'),
    };
    const res = runHook('hooks/subagent-brevity.mjs', payload, { args: ['--event', 'start'] });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal((res.stdout || '').trim(), '', 'must emit nothing when the marker already landed');
  } finally {
    cleanup();
  }
});

test('subagent-brevity --event start: marker absent -> additionalContext carries it', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-brevity-start-2',
      agent_id: 'agent-2',
      agent_type: 'general-purpose',
      agent_prompt: 'Do the thing.',
      transcript_path: join(dir, 'transcript.jsonl'),
    };
    const res = runHook('hooks/subagent-brevity.mjs', payload, { args: ['--event', 'start'] });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.json, `expected JSON stdout, got: ${res.stdout}`);
    assert.equal(res.json.hookSpecificOutput?.hookEventName, 'SubagentStart');
    assert.ok(
      res.json.hookSpecificOutput?.additionalContext?.includes(CONTRACT_MARKER),
      `expected CONTRACT_MARKER in additionalContext: ${JSON.stringify(res.json)}`,
    );
  } finally {
    cleanup();
  }
});

// --- 9. SubagentStop telemetry ------------------------------------------------
test('subagent-brevity --event stop: telemetry row lands in telemetry/brevity.jsonl', () => {
  const { cleanup } = makeFixture();
  try {
    const message = 'a short report';
    const payload = {
      session_id: 'sess-brevity-stop-1',
      agent_id: 'agent-3',
      agent_type: 'general-purpose',
      last_assistant_message: message,
    };
    const res = runHook('hooks/subagent-brevity.mjs', payload, { args: ['--event', 'stop'] });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);

    const rows = readJsonl(join(telemetryDir(), 'brevity.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'report');
    assert.equal(rows[0].report_chars, message.length);
    assert.equal(rows[0].session_id, 'sess-brevity-stop-1');
    assert.equal(rows[0].agent_id, 'agent-3');
    assert.equal(rows[0].contract_on, true);
    assert.equal(rows[0].contract_source, 'option');
    assert.equal(rows[0].gated, false);
  } finally {
    cleanup();
  }
});

// --- 10. SubagentStop gate: one shot per agent_id ---------------------------
test('subagent-brevity --event stop: gate fires once per agent_id', () => {
  const { cleanup } = makeFixture();
  try {
    const longMessage = 'x'.repeat(50);
    const payload = {
      session_id: 'sess-brevity-stop-2',
      agent_id: 'agent-drift-1',
      agent_type: 'general-purpose',
      last_assistant_message: longMessage,
    };
    const env = {
      CLAUDE_PLUGIN_OPTION_BREVITY_STOP_GATE: 'true',
      CLAUDE_PLUGIN_OPTION_BREVITY_REPORT_MAX_CHARS: '10',
    };

    const first = runHook('hooks/subagent-brevity.mjs', payload, { args: ['--event', 'stop'], env });
    assert.equal(first.status, 0, `stderr: ${first.stderr}`);
    assert.ok(first.json, `expected a block decision, got: ${first.stdout}`);
    assert.equal(first.json.decision, 'block');
    assert.ok(String(first.json.reason).includes(String(longMessage.length)));

    const second = runHook('hooks/subagent-brevity.mjs', payload, { args: ['--event', 'stop'], env });
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);
    assert.equal((second.stdout || '').trim(), '', 'the one-shot marker must suppress the second block');

    const rows = readJsonl(join(telemetryDir(), 'brevity.jsonl'));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].gated, true);
    assert.equal(rows[1].gated, false);
  } finally {
    cleanup();
  }
});

// --- 11. Fail-open -----------------------------------------------------------
test('subagent-brevity fails open when the state dir path is unwritable', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const blocker = join(dir, 'blocked-state-dir-brevity');
    writeFileSync(blocker, 'this is a file, not a directory');
    process.env.AGENT_COMPANION_STATE_DIR = blocker;

    const startPayload = {
      session_id: 'sess-failopen-brevity-start',
      agent_id: 'agent-fo-1',
      agent_type: 'general-purpose',
      agent_prompt: 'do the thing',
    };
    const startRes = runHook('hooks/subagent-brevity.mjs', startPayload, { args: ['--event', 'start'] });
    assert.equal(startRes.status, 0, `start must exit 0 even when its state dir is unwritable: stderr=${startRes.stderr}`);

    const stopPayload = {
      session_id: 'sess-failopen-brevity-stop',
      agent_id: 'agent-fo-2',
      agent_type: 'general-purpose',
      last_assistant_message: 'x'.repeat(20000),
    };
    const stopRes = runHook('hooks/subagent-brevity.mjs', stopPayload, {
      args: ['--event', 'stop'],
      env: { CLAUDE_PLUGIN_OPTION_BREVITY_STOP_GATE: 'true', CLAUDE_PLUGIN_OPTION_BREVITY_REPORT_MAX_CHARS: '10' },
    });
    assert.equal(stopRes.status, 0, `stop must exit 0 even when its state dir is unwritable: stderr=${stopRes.stderr}`);
  } finally {
    cleanup();
  }
});
