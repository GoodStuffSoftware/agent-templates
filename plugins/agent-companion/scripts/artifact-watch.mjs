#!/usr/bin/env node
// Artifact watch alerts CLI. Usage (arguments are stable; session-sync calls these after an account switch):
//   node scripts/artifact-watch.mjs scan [--since <iso>] [--json]   sessions with failed arms not yet alerted (transcript tails only)
//   node scripts/artifact-watch.mjs simulate --session <id> [--reset]  run the real PostToolUse hook on a fixture failure against an
//                                                                    isolated temp state dir; print what it injects. Never touches real state.
//   node scripts/artifact-watch.mjs status [--json]                  alerts sent (simulated records excluded)
// Read-only except simulate's own temp dir. No network.

import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeDir } from '../hooks/lib/context.mjs';
import { parseWatchResult, readSessionState, ALERTS_LOG, LIST_CALL } from '../hooks/lib/artifact-watch.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 200;
const DAY = 24 * 3600 * 1000;

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

function tailLines(path, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is cut
    return lines;
  } catch { return []; } finally { try { if (fd !== undefined) closeSync(fd); } catch { /* ignore */ } }
}

export function scan({ since, root = join(claudeDir(), 'projects') } = {}) {
  const cutoff = since ? Date.parse(since) : Date.now() - DAY;
  const files = [];
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* none */ }
  for (const d of dirs) {
    let es; try { es = readdirSync(join(root, d.name)); } catch { continue; }
    for (const e of es) {
      if (!e.endsWith('.jsonl')) continue;
      const p = join(root, d.name, e);
      try { const m = statSync(p).mtimeMs; if (m >= cutoff) files.push({ p, m }); } catch { /* gone */ }
    }
  }
  files.sort((a, b) => b.m - a.m);
  const out = [];
  for (const { p } of files.slice(0, MAX_FILES)) {
    const sid = basename(p, '.jsonl');
    const failed = new Map();
    for (const line of tailLines(p)) {
      if (!line.includes('"arms"') && !line.includes('"watches"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const r = o && o.toolUseResult;
      if (!r || typeof r !== 'object') continue;
      for (const f of parseWatchResult(r).obs) {
        if (f.status === 'failed') failed.set(f.url, f);
        else if (f.status === 'ok') failed.delete(f.url);
      }
    }
    const st = readSessionState(sid);
    const fresh = [...failed.values()].filter((f) => !(st.ok && st.data.urls[f.url] && st.data.urls[f.url].state === 'failed'));
    if (fresh.length) out.push({ session: sid, transcript: p, failures: fresh.map((f) => ({ ...f, atIso: f.at ? new Date(f.at).toISOString() : null })) });
  }
  return out;
}

export function status() {
  let records = [];
  try { records = readFileSync(ALERTS_LOG(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && !r.simulated); } catch { /* none */ }
  let sessions = 0;
  try { sessions = readdirSync(join(ALERTS_LOG(), '..', 'artifact-watch')).filter((n) => n.endsWith('.json')).length; } catch { /* none */ }
  return { alertsSent: records.length, sessionsTracked: sessions, alerts: records };
}

const SIM_AT = 1795582347544; // fixed
export function simulatePayload(session) {
  const url = 'https://claude.ai/artifact/SimulatedArtifact0001';
  return {
    session_id: session, hook_event_name: 'PostToolUse', tool_name: 'ArtifactComments', tool_input: { action: 'watch' },
    tool_response: { watches: [], arms: [{ url, state: 'failed', reason: 'no_subscription_token', at: SIM_AT }] },
    simulated: true,
  };
}

// The simulation's state dir: a temp dir that persists between runs (so a second run dedupes); --reset clears it.
export const simDir = () => process.env.AGENT_COMPANION_ARTIFACT_WATCH_SIM_DIR || join(tmpdir(), 'ac-artifact-watch-simulate');

function simulate(session, reset) {
  const dir = simDir();
  if (reset) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* none */ } }
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, AGENT_COMPANION_STATE_DIR: dir, AGENT_COMPANION_CODE_SESSIONS_DIR: join(dir, 'no-code-sessions') };
  delete env.CLAUDE_PLUGIN_OPTION_ARTIFACT_WATCH_ALERTS;
  const res = spawnSync(process.execPath, [join(HERE, '..', 'hooks', 'artifact-watch.mjs')], {
    input: JSON.stringify(simulatePayload(session)), encoding: 'utf8', windowsHide: true, timeout: 15000, env,
  });
  const out = (res.stdout || '').trim();
  if (!out) return '';
  try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch { return out; }
}

const isMain = !!process.argv[1] && /artifact-watch\.mjs$/.test(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const json = argv.includes('--json');
  if (cmd === 'scan') {
    const r = scan({ since: arg(argv, '--since') });
    if (json) console.log(JSON.stringify(r, null, 2));
    else if (!r.length) console.log('No failed artifact watches awaiting an alert.');
    else for (const s of r) for (const f of s.failures) console.log(`${s.session}  ${f.url}  ${f.atIso || '?'}  ${f.reason}`);
  } else if (cmd === 'simulate') {
    const s = arg(argv, '--session');
    if (!s) { console.error('usage: artifact-watch.mjs simulate --session <id> [--reset]'); process.exit(2); }
    const t = simulate(s, argv.includes('--reset'));
    if (t) console.log(t);
  } else if (cmd === 'status') {
    const r = status();
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`alerts sent: ${r.alertsSent}; sessions tracked: ${r.sessionsTracked}`);
      for (const a of r.alerts.slice(-20)) console.log(`${a.ts}  ${a.session}  ${a.url}  at=${a.at}  ${a.reason}${a.reminder ? '  (reminder)' : ''}`);
    }
  } else {
    console.error(`usage: artifact-watch.mjs scan [--since <iso>] [--json] | simulate --session <id> [--reset] | status [--json]\nSession list call: ArtifactComments ${LIST_CALL}`);
    process.exit(cmd ? 2 : 0);
  }
}
