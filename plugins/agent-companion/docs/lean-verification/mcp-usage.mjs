// Per MCP server (and Artifact/PowerShell), how many ac-* subagents used it over the last N days, by rung.
// usage: node mcp-usage.mjs [days=30]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const days = +(process.argv[2] || 30);
const cutoff = Date.now() - days * 864e5;
const root = path.join(os.homedir(), '.claude', 'projects');
const perType = {};            // agentType -> { n, servers: { server: Set(agentFile) } }
const total = { n: 0 };
for (const pd of fs.readdirSync(root)) {
  if (pd.includes('bench-') || pd.includes('ac-cache-ttl')) continue;
  const pdir = path.join(root, pd);
  let sessions; try { sessions = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
  for (const s of sessions) {
    if (!s.isDirectory()) continue;
    const sd = path.join(pdir, s.name, 'subagents');
    if (!fs.existsSync(sd)) continue;
    for (const f of fs.readdirSync(sd)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(sd, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      let type = '?';
      try { type = JSON.parse(fs.readFileSync(fp.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || '?'; } catch { /* no meta */ }
      type = type.replace(/^agent-companion:/, '');
      const rec = (perType[type] ??= { n: 0, servers: {} });
      rec.n += 1; total.n += 1;
      const seen = new Set();
      for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
        if (!line.includes('"tool_use"')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const c = o?.message?.content;
        if (!Array.isArray(c)) continue;
        for (const b of c) {
          if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
          const n = b.name;
          const key = n.startsWith('mcp__') ? n.split('__')[1] : (n === 'Artifact' || n === 'PowerShell' || n === 'SendMessage' || n === 'WebFetch' || n === 'WebSearch' || n === 'Monitor' || n === 'NotebookEdit' || n === 'Skill' ? n : null);
          if (key) seen.add(key);
        }
      }
      for (const k of seen) (rec.servers[k] ??= new Set()).add(fp);
    }
  }
}
const ac = Object.keys(perType).filter((t) => /^ac-/.test(t)).sort();
const servers = new Set();
for (const t of ac) for (const k of Object.keys(perType[t].servers)) servers.add(k);
console.log(`ac-* subagents scanned (last ${days}d): ${ac.reduce((a, t) => a + perType[t].n, 0)}`);
console.log('runs per rung: ' + ac.map((t) => `${t}=${perType[t].n}`).join(' '));
for (const s of [...servers].sort()) {
  const per = ac.map((t) => [t, perType[t].servers[s]?.size || 0]).filter(([, c]) => c > 0);
  const tot = per.reduce((a, [, c]) => a + c, 0);
  console.log(`${s.padEnd(34)} ${String(tot).padStart(4)} runs  ${per.map(([t, c]) => `${t.replace('ac-', '')}:${c}`).join(' ')}`);
}
