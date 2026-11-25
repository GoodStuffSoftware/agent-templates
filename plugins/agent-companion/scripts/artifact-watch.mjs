#!/usr/bin/env node
// Artifact watch alerts CLI. Usage (arguments are stable; session-sync calls these after an account switch):
//   node scripts/artifact-watch.mjs scan [--since <iso>] [--json]   sessions with failed arms not yet alerted (transcript tails only)
//   node scripts/artifact-watch.mjs simulate --session <id>          feed the PostToolUse hook a fixture failure; print what it injects
//   node scripts/artifact-watch.mjs status [--json]                  alerts sent, with dedupe state
// Read-only except simulate (which writes dedupe state and one alert record, like the real hook). No network.

import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeDir } from '../hooks/lib/context.mjs';
import { parseWatchResult, alertKey, ALERTED_FILE, ALERTS_LOG, LIST_CALL } from '../hooks/lib/artifact-watch.mjs';

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

function readAlerted() {
  try { return JSON.parse(readFileSync(ALERTED_FILE(), 'utf8')) || {}; } catch { return {}; }
}

export function scan({ since, root = join(claudeDir(), 'projects') } = {}) {
  const cutoff = since ? Date.parse(since) : Date.now() - DAY;
  const alerted = readAlerted();
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
    const live = new Set();
    const failed = new Map();
    for (const line of tailLines(p)) {
      if (!line.includes('"arms"') && !line.includes('"watches"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const r = o && o.toolUseResult;
      if (!r || typeof r !== 'object') continue;
      const { failures } = parseWatchResult(r);
      for (const w of Array.isArray(r.watches) ? r.watches : []) if (w && w.connected === true) { live.add(w.url); failed.delete(w.url); }
      for (const f of failures) { failed.set(f.url, f); live.delete(f.url); }
    }
    const fresh = [...failed.values()].filter((f) => !alerted[alertKey(sid, f)]);
    if (fresh.length) out.push({ session: sid, transcript: p, failures: fresh.map((f) => ({ ...f, atIso: f.at ? new Date(f.at).toISOString() : null })) });
  }
  return out;
}

export function status() {
  const alerted = readAlerted();
  let records = [];
  try { records = readFileSync(ALERTS_LOG(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* none */ }
  return { alertsSent: records.length, dedupeKeys: Object.keys(alerted).length, alerts: records };
}

const SIM_AT = 1795582347544; // fixed, so a second run of the same session dedupes
export function simulatePayload(session) {
  const url = 'https://claude.ai/artifact/SimulatedArtifact0001';
  return {
    session_id: session, hook_event_name: 'PostToolUse', tool_name: 'ArtifactComments', tool_input: { action: 'watch' },
    tool_response: { watches: [], arms: [{ url, state: 'failed', reason: 'no_subscription_token', at: SIM_AT }] },
    simulated: true,
  };
}

function simulate(session) {
  const res = spawnSync(process.execPath, [join(HERE, '..', 'hooks', 'artifact-watch.mjs')], {
    input: JSON.stringify(simulatePayload(session)), encoding: 'utf8', windowsHide: true, timeout: 15000,
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
    if (!s) { console.error('usage: artifact-watch.mjs simulate --session <id>'); process.exit(2); }
    const t = simulate(s);
    if (t) console.log(t);
  } else if (cmd === 'status') {
    const r = status();
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`alerts sent: ${r.alertsSent}; dedupe keys: ${r.dedupeKeys}`);
      for (const a of r.alerts.slice(-20)) console.log(`${a.ts}  ${a.session}  ${a.url}  at=${a.at}  ${a.reason}${a.simulated ? '  (simulated)' : ''}`);
    }
  } else {
    console.error(`usage: artifact-watch.mjs scan [--since <iso>] [--json] | simulate --session <id> | status [--json]\nSession list call: ArtifactComments ${LIST_CALL}`);
    process.exit(cmd ? 2 : 0);
  }
}
