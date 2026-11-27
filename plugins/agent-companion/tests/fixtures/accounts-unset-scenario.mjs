// One fixed scenario run with the option claude_accounts UNSET: a daily checkup over synthetic transcripts (history line and scan state)
// and a session-budget scan with its notice. accounts-unset-main.json holds this scenario's output as generated from origin/main's code
// (before the per-account gaps change): `node tests/fixtures/accounts-unset-scenario.mjs <plugin root of origin/main>`.
// tests/daily-checkup.test.mjs runs it on the current tree and compares the bytes. Fake data only.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeFixture } from '../helpers.mjs';

const SONNET = 'claude-sonnet-5-5';
const line = (id, ts, o, extra = {}) => JSON.stringify({
  type: 'assistant', timestamp: ts, requestId: id, uuid: `u-${id}`, ...extra,
  message: { id: `msg_${id}`, model: SONNET, usage: { input_tokens: 0, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

export async function scenario(pluginRoot) {
  const fx = makeFixture();
  const savedOpt = process.env.CLAUDE_PLUGIN_OPTION_CLAUDE_ACCOUNTS;
  delete process.env.CLAUDE_PLUGIN_OPTION_CLAUDE_ACCOUNTS;
  try {
    const mod = (rel) => import(pathToFileURL(join(pluginRoot, rel)).href);
    const dc = await mod('scripts/lib/daily-checkup.mjs');
    const sb = await mod('hooks/lib/session-budget.mjs');
    const root = join(fx.dir, 'transcripts');
    const lead = join(root, 'projA', 'sess-fake-1.jsonl');
    mkdirSync(join(root, 'projA'), { recursive: true });
    writeFileSync(lead, [
      line('r1', '2026-10-09T10:05:00Z', 3000000), line('r2', '2026-10-09T10:50:00Z', 1000000), line('r3', '2026-10-09T14:20:00Z', 2000000),
      line('r4', '2026-10-09T23:59:00Z', 500000),
    ].join('\n') + '\n');
    const sub = join(root, 'projA', 'sess-fake-1', 'subagents', 'agent-a1.jsonl');
    mkdirSync(join(root, 'projA', 'sess-fake-1', 'subagents'), { recursive: true });
    writeFileSync(sub, [line('s1', '2026-10-09T11:10:00Z', 800000)].join('\n') + '\n');
    const out = dc.runCheckup({ root, nowT: Date.parse('2026-10-10T09:00:00Z'), holdMs: 0 });
    const p = dc.checkupPaths();
    const strip = (s) => s.split(fx.dir).join('<D>').split(fx.dir.replace(/\\/g, '/')).join('<D>');
    const history = existsSync(p.history) ? readFileSync(p.history, 'utf8') : '';
    const state = existsSync(p.state) ? readFileSync(p.state, 'utf8') : '';
    // session budget: the same files, scanned
    const bstate = { files: {} };
    const r = sb.scanSession({ sessionId: 'sess-fake-1', transcriptPath: lead, deadline: Date.now() + 60000, state: bstate });
    const notice = sb.budgetNoticeText(r.total);
    return { written: out.written, history: strip(history), state: strip(state), budget: strip(JSON.stringify({ r, bstate })), notice };
  } finally {
    if (savedOpt === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_CLAUDE_ACCOUNTS; else process.env.CLAUDE_PLUGIN_OPTION_CLAUDE_ACCOUNTS = savedOpt;
    fx.cleanup();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2];
  if (!root) { process.stderr.write('usage: node accounts-unset-scenario.mjs <plugin root>\n'); process.exit(2); }
  process.stdout.write(`${JSON.stringify(await scenario(root), null, 1)}\n`);
}
