// 0.31.79: one deadline over the whole UserPromptSubmit hook (hooks/runaway-notice.mjs --no-watch) and scans cached between prompts.
// A big synthetic subagent tree stands in for the very large lead (1,146 files, 261 MB), whose hook timed out 78 times.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { queueNotice } from '../hooks/lib/runaway.mjs';

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const T1 = hoursAgo(2); const T2 = hoursAgo(1);

function bigTree(fx, { sid, files = 1200, interrupted = ['int-a', 'int-b'] }) {
  const proj = join(fx.dir, 'proj');
  const subs = join(proj, sid, 'subagents');
  mkdirSync(subs, { recursive: true });
  const lead = join(proj, `${sid}.jsonl`);
  writeFileSync(lead, '{"type":"user"}\n');
  const marker = (at) => ({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  const worker = (id, meta, records) => {
    writeFileSync(join(subs, `agent-${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify(meta));
  };
  // Priced assistant records give the budget scan real work on a cold state.
  const rec = (i) => JSON.stringify({ type: 'assistant', requestId: `r${i}`, timestamp: T1, message: { id: `m${i}`, role: 'assistant', model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 300, cache_read_input_tokens: 20000 }, content: [{ type: 'text', text: 'x'.repeat(200) }] } });
  const body = Array.from({ length: 60 }, (_, i) => rec(i)).join('\n') + '\n';
  for (let i = 0; i < files; i += 1) writeFileSync(join(subs, `agent-bulk-${i}.jsonl`), body);
  for (const id of interrupted) worker(id, { description: `cut ${id}`, name: id, requestShape: 'background' }, [marker(T1)]);
  const prompt = (env) => runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: sid, transcript_path: lead, prompt: 'go on' }, { args: ['--no-watch'], env });
  return { worker, marker, prompt };
}
const wall = (f) => { const a = Date.now(); const r = f(); return { r, ms: Date.now() - a }; };
const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext || '';

test('prompt hook: same notices cold and cached; a warm run reads only what changed', () => {
  const a = makeFixture();
  let cold; let warm; let baseline;
  try {
    const t = bigTree(a, { sid: 'lead-big-1' });
    cold = wall(() => t.prompt());
    baseline = ctx(cold.r);
    assert.equal(baseline.split('\n').filter((l) => /worker interrupted/.test(l)).length, 2, baseline);
    assert.match(baseline, /int-a "cut int-a"/);
    assert.match(baseline, /int-b "cut int-b"/);
    const cacheFile = join(a.stateDir, 'state', 'interrupted-scan', 'lead-big-1.json');
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.equal(Object.keys(cache.files).length, 1202);
    // An unchanged file is not re-read: a tampered cache entry (same size and mtime) is believed.
    cache.files['agent-bulk-7.jsonl'] = { ...cache.files['agent-bulk-7.jsonl'], i: 1, at: T2 };
    writeFileSync(cacheFile, JSON.stringify(cache));
    t.worker('int-c', { description: 'cut c', name: 'int-c', requestShape: 'background' }, [t.marker(T2)]);
    warm = wall(() => t.prompt());
    const w = ctx(warm.r);
    assert.equal(w.split('\n').filter((l) => /worker interrupted/.test(l)).length, 2, w);
    assert.match(w, /int-c "cut c"/);
    assert.match(w, /bulk-7/, 'the unchanged file came from the cache, not a re-read');
    assert.equal(t.prompt().stdout.trim(), '', 'nothing new on the next prompt');
  } finally { a.cleanup(); }
  // The same tree in a second, empty state dir says the same (the cache never changes what is said).
  const b = makeFixture();
  try {
    assert.equal(ctx(bigTree(b, { sid: 'lead-big-1' }).prompt()), baseline);
  } finally { b.cleanup(); }
  console.log(`# synthetic 1202 files: cold ${cold.ms} ms, warm ${warm.ms} ms`);
});

test('prompt hook: a deadline cuts the scans, ends in time and still delivers the queued notice', () => {
  const fx = makeFixture();
  try {
    const t = bigTree(fx, { sid: 'lead-big-2', files: 1500 });
    queueNotice('lead-big-2', '[agent-companion] queued runaway line');
    const r = wall(() => t.prompt({ AC_RUNAWAY_DEADLINE_MS: '1' }));
    assert.equal(r.r.status, 0);
    assert.match(ctx(r.r), /queued runaway line/);
    assert.ok(r.ms < 4000, `cut run took ${r.ms} ms`);
    // The cut kept its progress: a later, uncut prompt finishes the scan and reports the interrupted workers.
    const full = ctx(t.prompt());
    assert.match(full, /int-a/);
    assert.match(full, /int-b/);
  } finally { fx.cleanup(); }
});

test('prompt hook: cut runs converge to the notices of an unlimited run, with the budget scan and the cache complete', () => {
  const lines = (s) => s.split('\n').filter((l) => /worker interrupted/.test(l)).sort();
  const a = makeFixture();
  let want;
  try { want = lines(ctx(bigTree(a, { sid: 'lead-conv', files: 600 }).prompt())); } finally { a.cleanup(); }
  assert.equal(want.length, 2);
  const b = makeFixture();
  try {
    const t = bigTree(b, { sid: 'lead-conv', files: 600 });
    const got = new Set();
    const cacheOf = () => { try { return Object.keys(JSON.parse(readFileSync(join(b.stateDir, 'state', 'interrupted-scan', 'lead-conv.json'), 'utf8')).files).length; } catch { return 0; } };
    let runs = 0;
    while (runs < 60 && cacheOf() < 602) {
      for (const l of lines(ctx(t.prompt({ AC_RUNAWAY_DEADLINE_MS: '150' })))) got.add(l);
      runs += 1;
    }
    assert.ok(cacheOf() >= 602, `the cache filled within ${runs} cut prompts`);
    assert.deepEqual([...got].sort(), want);
    assert.equal(t.prompt().stdout.trim(), '', 'nothing new once converged');
    const st = JSON.parse(readFileSync(join(b.stateDir, 'state', 'session-budget', 'lead-conv.json'), 'utf8'));
    assert.ok(Object.keys(st.files).length >= 601, 'the budget scan covers every transcript');
    console.log(`# converged after ${runs} cut prompts (150 ms deadline)`);
  } finally { b.cleanup(); }
});
