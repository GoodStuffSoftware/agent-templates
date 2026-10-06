// What did this subagent start with?  usage: node inspect-subagent.mjs <subagent-transcript.jsonl> [--json]
//
// Reads the first rows of a subagent transcript (agent-<id>.jsonl under
// ~/.claude/projects/<proj>/<session>/subagents/) and prints:
//   - its tools (prompt_snapshot.tools), grouped by MCP server, and which of the
//     tools a lean ac-* definition should drop are still present
//   - skills-listing chars
//   - deferred-tool name count (by server) and MCP-instruction servers, taken from
//     the attachment rows the harness writes before the first model call
//   - whether CLAUDE.md / MEMORY.md were injected (the `instructions` attachment
//     plus any "# claudeMd" / "Contents of ... MEMORY.md" text in the first user rows)
//   - first-call tokens (input + cache read + cache creation of the first assistant row)
//   - the subagent's own agentType from its .meta.json, and hook-injected contract count
//
// Verdicts printed at the end ("CHECK ...") are the facts the S1/S2/S3 release needs:
//   CHECK dropped-server-schemas   no tool of a dropped server is in the tools array
//   CHECK dropped-server-deferred  no deferred name of a dropped server was announced
//   CHECK dropped-server-instr     a dropped server sent no instruction block
//   CHECK claudemd / memorymd      what omitClaudeMd did
// A "dropped" server is any name passed with --dropped (comma list, default is the
// ac-* lean list). Pass --kept to assert servers that must still be there.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const asJson = args.includes('--json');
if (!file) { console.error('usage: node inspect-subagent.mjs <subagent-transcript.jsonl> [--dropped a,b] [--kept a,b] [--json]'); process.exit(2); }
const DEFAULT_DROPPED = 'Artifact,visualize,terminal,ccd_session,ccd_connectors,ccd_directory,ccd_pr,ccd_sidebar,ccd_view,ccd_window,mcp-registry,Claude_Browser,claude-in-chrome,computer-use,ccd_session_mgmt';
const dropped = flag('--dropped', DEFAULT_DROPPED).split(',').map((s) => s.trim()).filter(Boolean);
const kept = flag('--kept', '').split(',').map((s) => s.trim()).filter(Boolean);

const server = (n) => (n.startsWith('mcp__') ? n.split('__')[1] : n === 'Artifact' || n === 'ArtifactComments' || n === 'ArtifactData' ? 'Artifact' : '(builtin)');

const lines = fs.readFileSync(file, 'utf8').split('\n');
const rows = [];
for (const l of lines) {
  if (!l) continue;
  try { rows.push(JSON.parse(l)); } catch { /* torn line */ }
  if (rows.length >= 120) break;
}

let meta = {};
try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* none */ }

const out = { file: path.basename(file), agentType: meta.agentType || null };

// prompt_snapshot: the row with the largest snapshot
let snap = null;
for (const o of rows) {
  const a = o.attachment;
  if (a?.type === 'prompt_snapshot' && (!snap || JSON.stringify(a).length > JSON.stringify(snap).length)) snap = a;
}
const tools = snap && Array.isArray(snap.tools) ? snap.tools.map((t) => t.name || t.function?.name || '?') : null;
out.tools = tools ? { count: tools.length, bySrv: {} } : null;
if (tools) for (const n of tools) out.tools.bySrv[server(n)] = (out.tools.bySrv[server(n)] || 0) + 1;
out.toolsChars = snap && Array.isArray(snap.tools) ? JSON.stringify(snap.tools).length : null;
out.systemPromptChars = snap?.systemPrompt ? JSON.stringify(snap.systemPrompt).length : null;

// skills listing, deferred names, MCP instructions, instructions (CLAUDE.md)
out.skillsListingChars = 0; out.deferredNames = 0; out.deferredBySrv = {}; out.mcpInstructionServers = [];
out.instructionFiles = []; out.agentListingChars = 0; out.hookContexts = [];
for (const o of rows) {
  const a = o.attachment;
  if (!a) continue;
  if (a.type === 'skill_listing') out.skillsListingChars += JSON.stringify(a.content ?? a).length;
  if (a.type === 'deferred_tools_delta') {
    for (const n of a.addedNames || []) { out.deferredNames += 1; const s = server(n); out.deferredBySrv[s] = (out.deferredBySrv[s] || 0) + 1; }
  }
  if (a.type === 'mcp_instructions_delta') for (const n of a.addedNames || []) out.mcpInstructionServers.push(n);
  if (a.type === 'agent_listing_delta') out.agentListingChars += JSON.stringify(a).length;
  if (a.type === 'instructions') for (const f of a.files || []) out.instructionFiles.push(Array.isArray(f) ? f.slice(0, 3) : [f.path || JSON.stringify(f).slice(0, 80), f.type, typeof f.content === 'string' ? f.content.length : '?']);
  if (a.type === 'hook_additional_context') out.hookContexts.push(String(JSON.stringify(a.content)).slice(0, 80));
}
const textOfRow = (o) => {
  const c = o.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n');
  return '';
};
const userText = rows.filter((o) => o.type === 'user').map(textOfRow).join('\n');
const instrPaths = out.instructionFiles.map((f) => String(f[0]));
// The harness records the injected instruction files (CLAUDE.md, MEMORY.md) as an `instructions`
// attachment whose files are { path, type, content }. A CLAUDE.md is "injected" when one of those paths
// ends in CLAUDE.md; MEMORY.md when a path ends in MEMORY.md.
out.claudeMdInjected = instrPaths.some((p) => /CLAUDE[.]md/i.test(p)) || /Contents of [^"\n]{0,200}CLAUDE[.]md/.test(userText);
out.memoryMdInjected = instrPaths.some((p) => /MEMORY[.]md/i.test(p)) || /Contents of [^"\n]{0,200}MEMORY[.]md/.test(userText);
out.contractCount = (userText.match(/\[agent-companion: reporting contract\]/g) || []).length + out.hookContexts.filter((h) => /reporting contract/.test(h)).length;

// first-call tokens
const first = rows.find((o) => o.type === 'assistant' && o.message?.usage);
const u = first?.message?.usage;
out.firstCallTokens = u ? { input: u.input_tokens, cacheRead: u.cache_read_input_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0, total: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), model: first.message.model } : null;

// verdicts
const present = (name) => (out.tools?.bySrv[name] || 0);
out.checks = [];
const chk = (id, ok, detail) => out.checks.push({ id, ok, detail });
if (out.tools) {
  const left = dropped.filter((s) => present(s) > 0);
  chk('dropped-server-schemas', left.length === 0, left.length ? `still in tools: ${left.join(', ')}` : 'no tool of a dropped server is in the tools array');
  const keptMissing = kept.filter((s) => present(s) === 0);
  if (kept.length) chk('kept-server-schemas', keptMissing.length === 0, keptMissing.length ? `missing: ${keptMissing.join(', ')}` : `present: ${kept.join(', ')}`);
}
const deferredLeft = dropped.filter((s) => (out.deferredBySrv[s] || 0) > 0);
chk('dropped-server-deferred', deferredLeft.length === 0, deferredLeft.length ? `deferred names still announced for: ${deferredLeft.map((s) => `${s}(${out.deferredBySrv[s]})`).join(', ')}` : 'no deferred name of a dropped server was announced');
const instrLeft = dropped.filter((s) => out.mcpInstructionServers.some((n) => n === s || n.endsWith(s)));
chk('dropped-server-instr', instrLeft.length === 0, instrLeft.length ? `instruction block still sent by: ${instrLeft.join(', ')}` : 'no dropped server sent an instruction block');
chk('claudemd-injected', true, String(out.claudeMdInjected));
chk('memorymd-injected', true, String(out.memoryMdInjected));
chk('contract-once', out.contractCount <= 1, `reporting contract appears ${out.contractCount}x`);

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`file:            ${out.file}   agentType: ${out.agentType}`);
console.log(`first call:      ${out.firstCallTokens ? `${out.firstCallTokens.total} tokens (input ${out.firstCallTokens.input}, cache read ${out.firstCallTokens.cacheRead}, cache create ${out.firstCallTokens.cacheCreate}) model ${out.firstCallTokens.model}` : 'no assistant row with usage in the first 120 rows'}`);
console.log(`tools:           ${out.tools ? `${out.tools.count} tools, ${out.toolsChars} chars; ${Object.entries(out.tools.bySrv).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}` : 'no prompt_snapshot found'}`);
console.log(`skills listing:  ${out.skillsListingChars} chars`);
console.log(`agent listing:   ${out.agentListingChars} chars (delta row)`);
console.log(`deferred names:  ${out.deferredNames}  (${Object.entries(out.deferredBySrv).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.slice(0, 18)}:${v}`).join(' ')})`);
console.log(`MCP instruction servers: ${out.mcpInstructionServers.join(', ') || '(none)'}`);
console.log(`instruction files: ${out.instructionFiles.map((f) => `${f[0]}(${f[2] ?? '?'})`).join(', ') || '(none)'}  CLAUDE.md injected: ${out.claudeMdInjected}  MEMORY.md injected: ${out.memoryMdInjected}`);
console.log(`system prompt:   ${out.systemPromptChars ?? '?'} chars`);
console.log('');
for (const c of out.checks) console.log(`CHECK ${c.id.padEnd(26)} ${c.ok ? 'PASS' : 'FAIL'}  ${c.detail}`);
