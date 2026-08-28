// Optional telemetry upload — one script, wired to Stop and SessionEnd.
//
// OFF BY DEFAULT. With no `telemetry_endpoint` configured this exits before
// touching the network, so the plugin makes no outbound calls at all. Setting
// an endpoint is the single action that turns sending on.
//
// WHY NOT PreToolUse:
//   PreToolUse is a BLOCKING hook — it runs before the tool call proceeds. A
//   network call there puts your endpoint's latency in front of every single
//   tool call, and a slow or dead endpoint stalls each one until the hook
//   timeout. That does not fail loudly; it just makes the agent feel broken,
//   which is far harder to diagnose than an outage.
//
// WHY BOTH Stop AND SessionEnd:
//   Stop fires at each turn boundary and is throttled, so telemetry flows
//   during a long session instead of only at the end. SessionEnd bypasses the
//   throttle because there may be no next turn — and for a cloud session it is
//   the last moment the data exists at all, since the filesystem is destroyed
//   with the session and there is no later sweep.
//
//   Coverage is a sample, not a census: SessionEnd's reasons are clear, resume,
//   logout, prompt_input_exit, other, and bypass_permissions_disabled. There is
//   no idle-timeout reason, and a killed process cannot run its own hook. The
//   local JSONL stays on disk so a local machine can be swept later; a vanished
//   cloud session simply loses its last interval.
//
// Token cost: zero. This is a subprocess; no model is invoked.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readStdin, opt, dataDir, stateFile, readJson, writeJson, passthrough } from './lib/context.mjs';

const FILES = ['spawns.jsonl', 'subagent-starts.jsonl', 'unknown-agent-types.jsonl', 'denials.jsonl'];
const TIMEOUT_MS = 3000;

// A cloud session's filesystem dies with it and there is no later sweep, so it
// ships more often. A local session is backstopped by the on-disk JSONL, so it
// can afford to wait. `CLAUDE_CODE_REMOTE_SESSION_ID` is set in remote/cloud
// sessions — the same marker the built-in agent proxy keys off.
const IS_CLOUD = Boolean(process.env.CLAUDE_CODE_REMOTE_SESSION_ID);

try {
  const endpoint = String(opt('telemetry_endpoint', '') || '').trim();
  if (!endpoint) passthrough(); // default path: no config, no network, no cost

  // The token is read from the ENVIRONMENT, never from plugin config. userConfig
  // values are stored in settings.json in plaintext, and project-scoped settings
  // get committed — a shared ingest secret does not belong there.
  const token = process.env.AGENT_AUDIT_TOKEN || '';
  if (!token) passthrough(); // configured endpoint but no secret: stay silent

  const payload = readStdin();

  // THROTTLE — this is what replaces a background timer.
  //
  // A detached daemon either outlives its session (orphan) or dies with it
  // (useless), and in a cloud sandbox it is fragile besides. Instead we let an
  // already-firing hook carry the work and rate-limit it here: under the
  // interval, this exits after one file read, costing a process spawn and no
  // network. That gives "send every N minutes of activity" with nothing to
  // schedule, nothing to leak, and no need to know how long a cloud session
  // lives — the worst case is losing one interval whenever it vanishes.
  //
  // SessionEnd always sends: it is the last chance, and there may not be another.
  const isFinal = payload.hook_event_name === 'SessionEnd';
  const intervalMin = IS_CLOUD
    ? Math.max(1, opt('telemetry_interval_cloud_min', 10))
    : Math.max(1, opt('telemetry_interval_local_min', 60));
  const dir = dataDir();
  const tenant = String(opt('telemetry_tenant', 'default'));

  const idFile = stateFile('upload-state.json');
  const state = readJson(idFile, { machineId: '', label: hostname(), offsets: {}, lastSentAt: 0 });
  if (!state.machineId) state.machineId = randomUUID();

  // The throttle itself: on a turn-boundary fire, do nothing unless enough time
  // has passed since the last successful send. This is the whole mechanism —
  // one file read, then exit. SessionEnd bypasses it because there may be no
  // next turn.
  const sinceMin = (Date.now() - (state.lastSentAt || 0)) / 60000;
  if (!isFinal && sinceMin < intervalMin) passthrough();

  const batch = [];
  const nextOffsets = { ...(state.offsets || {}) };
  for (const name of readdirSync(dir).filter((f) => FILES.includes(f))) {
    let text;
    try { text = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    const lines = text.split('\n').filter((l) => l.trim());
    const sent = state.offsets?.[name] || 0;
    // A shrunken file was rotated or truncated; restart rather than skipping
    // the new content now sitting below the old offset.
    const start = lines.length < sent ? 0 : sent;
    batch.push(...lines.slice(start));
    nextOffsets[name] = lines.length;
  }
  if (batch.length === 0) passthrough();

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-ndjson',
      'X-Machine-Id': state.machineId,
      'X-Machine-Label': state.label || hostname(),
      'X-Tenant': tenant,
    },
    body: batch.join('\n'),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // Advance the cursor only on success. Re-sending is free — ingest dedupes on
  // a content hash — while losing records is not. The cursor is an
  // optimisation, never the correctness mechanism.
  if (res.ok) writeJson(idFile, { ...state, offsets: nextOffsets, lastSentAt: Date.now() });
} catch {
  // Fail silent, always. A telemetry endpoint being down must never surface as
  // an error at the end of someone's session, and must never lose data: the
  // cursor stays put and the local JSONL is still on disk to sweep later.
}
passthrough();
