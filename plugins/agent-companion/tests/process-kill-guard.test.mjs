// kill_by_name_guard + the `claude plugin uninstall` deny (0.31.25). The pure check
// (hooks/lib/process-kill-guard.mjs) is exercised in-process; the hook-level tests spawn
// hooks/poll-guard.mjs (the host hook) and run on every platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { runHook, decisionOf } from './helpers.mjs';
import { processGuardHits, processGuard, KILL_MSG, UNINSTALL_MSG } from '../hooks/lib/process-kill-guard.mjs';

const NL = '\n';
const kills = (cmd, shell = 'bash') => processGuardHits(cmd, shell).kill;
const uninstalls = (cmd, shell = 'bash') => processGuardHits(cmd, shell).uninstall;

const KILL_BASH = [
  'taskkill /F /IM node.exe /T',
  'taskkill /IM node.exe',
  'taskkill //F //IM node.exe',
  'taskkill /im java.exe /f',
  'taskkill /F /FI "IMAGENAME eq node.exe"',
  'taskkill /F node.exe',
  'taskkill /PID 123 /IM node.exe',
  'C:/Windows/System32/taskkill.exe /F /IM chrome.exe',
  'C:\\Windows\\System32\\taskkill.exe /F /IM chrome.exe',
  'pkill node',
  'pkill -f playwright',
  'sudo pkill -9 java',
  'killall node',
  'killall -9 qemu-system-x86_64',
  'cd /tmp && pkill -f vite',
  'echo start; killall chrome; echo done',
  'bash -c "pkill -f vite"',
  "sh -c 'killall node'",
  'bash -lc "taskkill //F //IM node.exe"',
  'cmd /c "taskkill /F /IM node.exe"',
  'cmd //c taskkill //F //IM node.exe',
  'cmd.exe /c taskkill /IM node.exe /F',
  'powershell -Command "Stop-Process -Name node -Force"',
  "powershell.exe -NoProfile -Command 'Get-Process node | Stop-Process -Force'",
  'pwsh -c "Get-Process chrome | Stop-Process"',
  'eval "pkill node"',
  'x=$(pkill node)',
  'FOO=1 pkill node',
  'env FOO=1 pkill node',
  'timeout 5 pkill node',
  'nohup killall node &',
  'wmic process where name="node.exe" delete',
  'wmic process where "name=\'java.exe\'" call terminate',
  'wmic process where caption="x.exe" delete',
  'kill $(pgrep node)',
  'kill -9 $(pgrep -f vite)',
  'kill -9 `pidof node`',
  'taskkill //PID $(pgrep node)',
  'pgrep -f vite | xargs kill',
  'pgrep node | xargs -r kill -9',
  'pidof node | xargs kill',
  `cat <<'E' | bash${NL}pkill node${NL}E`,
  `bash <<'E'${NL}pkill node${NL}E`,
  `bash -s <<'E'${NL}killall node${NL}E`,
  `echo hi${NL}pkill node`,
];
const KILL_PS = [
  'Stop-Process -Name node',
  'Stop-Process -Name node -Force',
  'Stop-Process -ProcessName node',
  'Stop-Process -Name:node',
  'Stop-Process -N node',
  'Stop-Process -Pro node',
  'stop-process -name chrome,node -force',
  'spps -Name node',
  'kill -Name node',
  'Get-Process node | Stop-Process',
  'Get-Process -Name node | Stop-Process -Force',
  'Get-Process node,chrome | Stop-Process -Force',
  'gps node | spps',
  'Get-Process | Stop-Process',
  'Get-Process node | ForEach-Object { Stop-Process -Id $_.Id }',
  'Get-Process node | % { $_.Kill() }',
  'Get-Process node | Where-Object { $_.CPU -gt 100 } | Stop-Process',
  '(Get-Process node).Kill()',
  'Stop-Process -Id (Get-Process node).Id',
  '[System.Diagnostics.Process]::GetProcessesByName("node") | ForEach-Object { $_.Kill() }',
  'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Invoke-CimMethod -MethodName Terminate',
  'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Remove-CimInstance',
  'Get-CimInstance -ClassName Win32_Process -Filter "CommandLine like \'%vite%\'" | ForEach-Object { $_.Terminate() }',
  'Get-WmiObject Win32_Process -Filter "name=\'java.exe\'" | ForEach-Object { $_.Terminate() }',
  'gwmi Win32_Process | % { $_.Terminate() }',
  '(Get-WmiObject Win32_Process -Filter "name=\'node.exe\'").Terminate()',
  'wmic process where name="node.exe" delete',
  'taskkill /F /IM node.exe',
  'taskkill /IM chrome.exe',
  '& taskkill /F /IM node.exe',
  'ps node | kill',
  'Get-Process node; pkill x',
  'if ($true) { Stop-Process -Name node }',
  'cmd /c taskkill /F /IM node.exe',
  'powershell -Command "taskkill /F /IM node.exe"',
  'Invoke-Expression "Stop-Process -Name node"',
  'iex "taskkill /IM node.exe"',
];
const ALLOW_BASH = [
  'taskkill /PID 123',
  'taskkill /F /PID 123',
  'taskkill /F /T /PID 4242',
  'taskkill //F //T //PID 4242',
  'taskkill /pid 77 /f',
  'taskkill /?',
  'kill 123',
  'kill -9 123',
  'kill -TERM 123 456',
  'kill -s KILL 99',
  'kill %1',
  'kill $pid',
  'kill $!',
  'kill $(cat /tmp/app.pid)',
  'kill $(pgrep -P $$)',
  'pgrep node',
  'pgrep -f vite',
  'pidof node',
  'ps aux | grep node',
  'tasklist | grep node',
  'tasklist /FI "IMAGENAME eq node.exe"',
  'echo "pkill node"',
  "echo 'taskkill /IM node.exe'",
  'echo taskkill /IM node.exe | cat',
  'grep -r pkill .',
  'grep "taskkill /IM" docs/',
  'rg -n "killall" plugins',
  'git commit -m "deny taskkill /IM and pkill"',
  'git log --grep="taskkill /F /IM"',
  'printf "%s\\n" "Stop-Process -Name node"',
  'echo $(echo pkill node)',
  '# pkill node',
  'ls # killall node',
  'cat README.md',
  'cat <<\'E\'' + NL + 'pkill node' + NL + 'taskkill /F /IM node.exe' + NL + 'E',
  'cat > notes.md <<EOF' + NL + 'Never run killall node' + NL + 'EOF',
  'node scripts/kill-port.mjs 3000',
  'npm run pkill-helper',
  'git -C C:/repo status',
  'bash -c "echo pkill"',
  "bash -c 'kill 123'",
  'bash -c "taskkill //F //PID 123"',
  'sh scripts/killall.sh',
  './scripts/pkill-wrapper.sh',
  'killall5-info',
  'claude plugin update agent-companion@agent-templates',
  'claude plugin disable agent-companion@agent-templates',
  'claude plugin marketplace update agent-templates',
  'cmd /c "taskkill /F /PID 123"',
  'powershell -Command "Stop-Process -Id 123 -Force"',
  'powershell -Command "Get-Process -Id 123"',
  'powershell -Command "Get-Process node"',
  'wmic process where processid=123 delete',
  'wmic process where "processid=123" call terminate',
  'wmic process list brief',
  'wmic process get name,processid',
  'wmic os get caption',
  'xargs echo',
  'cat pids | xargs kill',
  'echo "kill me" > f',
  'kill_all_helper --dry-run',
];
const ALLOW_PS = [
  'Stop-Process -Id 123',
  'Stop-Process -Id 123 -Force',
  'Stop-Process -Id $pid',
  'Stop-Process -Id 1,2,3',
  'Stop-Process 123',
  'Stop-Process -InputObject $p',
  'Stop-Process -Id $p.Id -PassThru',
  'spps -Id 55',
  'kill 123',
  'kill -Id 123',
  'taskkill /PID 123 /F',
  'taskkill /F /T /PID 123',
  'Get-Process node',
  'Get-Process -Name node | Select-Object Id,ProcessName',
  'Get-Process node | Format-Table',
  'Get-Process -Id 123 | Stop-Process',
  'Get-Process -Id $x | Stop-Process -Force',
  'gps -Id 7 | spps',
  'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,ParentProcessId,CommandLine',
  'Get-CimInstance Win32_Process -Filter "ProcessId=123" | Invoke-CimMethod -MethodName Terminate',
  'Get-CimInstance Win32_Process -Filter "ParentProcessId=123" | Select ProcessId',
  'Get-WmiObject Win32_Process -Filter "processid = 55" | ForEach-Object { $_.Terminate() }',
  'Get-Process node; Stop-Process -Id 5',
  'Get-Process node' + NL + 'Stop-Process -Id 5',
  'Write-Host "Stop-Process -Name node"',
  'Write-Output \'taskkill /IM node.exe\'',
  'Select-String -Pattern "pkill" -Path *.md',
  'echo "Get-Process node | Stop-Process"',
  '$p = Start-Process node -PassThru; Stop-Process -Id $p.Id',
  '$p = Start-Process node -PassThru; $p.Kill()',
  '$proc.Kill()',
  '$_.Kill()',
  'Get-ChildItem | Format-List',
  'Stop-Service -Name foo',
  'Restart-Service -Name spooler',
  '"Stop-Process -Name node" | Out-File notes.txt',
  '# Stop-Process -Name node',
];

for (const c of KILL_BASH) test(`kill-by-name denied (bash): ${JSON.stringify(c).slice(0, 90)}`, () => assert.ok(kills(c, 'bash'), c));
for (const c of KILL_PS) test(`kill-by-name denied (powershell): ${JSON.stringify(c).slice(0, 90)}`, () => assert.ok(kills(c, 'powershell'), c));
for (const c of ALLOW_BASH) test(`kill rule allows (bash): ${JSON.stringify(c).slice(0, 90)}`, () => assert.equal(kills(c, 'bash'), null, c));
for (const c of ALLOW_PS) test(`kill rule allows (powershell): ${JSON.stringify(c).slice(0, 90)}`, () => assert.equal(kills(c, 'powershell'), null, c));

test('the messages name the replacement: find the PID, walk the parent chain, kill by PID', () => {
  assert.match(KILL_MSG, /find the PID/);
  assert.match(KILL_MSG, /parent\s+chain/);
  assert.match(KILL_MSG, /taskkill \/PID/);
  assert.match(KILL_MSG, /kill_by_name_guard/);
});

// --- claude plugin uninstall -------------------------------------------------------------------
const UNINSTALL = [
  'claude plugin uninstall agent-companion@agent-templates',
  'claude plugin uninstall agent-companion',
  'claude plugin remove agent-companion@agent-templates',
  'claude plugin rm agent-companion@agent-templates',
  'claude plugins uninstall x',
  'claude plugin uninstall --scope user agent-companion@agent-templates',
  'claude --debug plugin uninstall x',
  'claude.exe plugin uninstall x',
  'C:/Users/me/.local/bin/claude.exe plugin uninstall x',
  'CLAUDE_CONFIG_DIR=/tmp/x claude plugin uninstall x',
  'env CLAUDE_CONFIG_DIR=/tmp/x claude plugin uninstall x',
  'cd /repo && claude plugin uninstall x && echo done',
  'claude plugin update x; claude plugin uninstall y',
  'claude plugin disable x || claude plugin uninstall x',
  'bash -c "claude plugin uninstall x"',
  "sh -c 'claude plugin uninstall x'",
  'powershell -Command "claude plugin uninstall x"',
  'cmd /c claude plugin uninstall x',
  'x=$(claude plugin uninstall y)',
  'nohup claude plugin uninstall x &',
  'timeout 30 claude plugin uninstall x',
  'sudo claude plugin uninstall x',
  'npx @anthropic-ai/claude-code plugin uninstall x',
  `claude plugin list${NL}claude plugin uninstall x`,
  'CLAUDE plugin UNINSTALL x',
  '"claude" plugin "uninstall" x',
  'eval "claude plugin uninstall x"',
];
const UNINSTALL_PS = [
  '& claude plugin uninstall x',
  'claude plugin uninstall x',
  'claude.exe plugin remove x',
  'Invoke-Expression "claude plugin uninstall x"',
  'cmd /c "claude plugin uninstall x"',
];
const NOT_UNINSTALL = [
  'claude plugin update agent-companion@agent-templates',
  'claude plugin install agent-companion@agent-templates',
  'claude plugin disable agent-companion@agent-templates',
  'claude plugin enable agent-companion@agent-templates',
  'claude plugin list',
  'claude plugin marketplace update agent-templates',
  'claude plugin marketplace list',
  'claude plugin validate .',
  'claude --version',
  'claude -p "claude plugin uninstall is denied"',
  'echo "claude plugin uninstall x"',
  "echo 'claude plugin uninstall x' > note.txt",
  'grep -rn "plugin uninstall" docs',
  'git commit -m "deny claude plugin uninstall"',
  `cat <<'E'${NL}claude plugin uninstall x${NL}E`,
  '# claude plugin uninstall x',
  'npm uninstall left-pad',
  'npm plugin remove x',
  'pip uninstall foo',
  'plugin uninstall x',
  'claude mcp remove foo',
  'bash -c "echo claude plugin uninstall"',
  'node scripts/plugin-uninstall-helper.mjs',
];
for (const c of UNINSTALL) test(`plugin uninstall denied: ${JSON.stringify(c).slice(0, 90)}`, () => assert.equal(uninstalls(c, 'bash'), true, c));
for (const c of UNINSTALL_PS) test(`plugin uninstall denied (powershell): ${JSON.stringify(c).slice(0, 90)}`, () => assert.equal(uninstalls(c, 'powershell'), true, c));
for (const c of NOT_UNINSTALL) test(`plugin uninstall rule allows: ${JSON.stringify(c).slice(0, 90)}`, () => assert.equal(uninstalls(c, 'bash'), false, c));

test('uninstall message gives the supported path', () => {
  assert.match(UNINSTALL_MSG, /marketplace update/);
  assert.match(UNINSTALL_MSG, /claude plugin update/);
  assert.match(UNINSTALL_MSG, /disable then re-enable/);
  assert.match(UNINSTALL_MSG, /no switch/);
});

// --- robustness ---------------------------------------------------------------------------------
test('never throws and allows on odd input', () => {
  for (const v of [undefined, null, '', '   ', '\n\n', '"', "'", '$(', '`', '((((', '))))', '{ {', '<<', '<<E', 'kill "', 'taskkill $(']) {
    assert.doesNotThrow(() => processGuardHits(v, 'bash'));
    assert.doesNotThrow(() => processGuardHits(v, 'powershell'));
  }
  assert.equal(kills(undefined), null);
});
test('a very long command allows instead of hanging (budget)', () => {
  const big = 'echo ' + 'a '.repeat(300000) + '&& pkill node';
  const t = Date.now();
  processGuardHits(big, 'bash'); // either verdict is acceptable; it must return
  assert.ok(Date.now() - t < 5000);
});
test('processGuard: mode switches the kill rule, never the uninstall rule', () => {
  const payload = (command, tool_name = 'Bash') => ({ tool_name, tool_input: { command } });
  assert.equal(processGuard(payload('pkill node'), { mode: 'deny' }).mode, 'deny');
  assert.equal(processGuard(payload('pkill node'), { mode: 'warn' }).mode, 'warn');
  assert.equal(processGuard(payload('pkill node'), { mode: 'off' }), null);
  assert.equal(processGuard(payload('pkill node'), { mode: 'OFF' }), null);
  assert.equal(processGuard(payload('pkill node'), {}).mode, 'deny');
  assert.equal(processGuard(payload('taskkill /PID 5'), { mode: 'deny' }), null);
  for (const mode of ['deny', 'warn', 'off']) {
    const r = processGuard(payload('claude plugin uninstall x'), { mode });
    assert.equal(r.kind, 'plugin-uninstall');
    assert.equal(r.mode, 'deny');
  }
  assert.equal(processGuard(payload('Stop-Process -Name node', 'PowerShell'), {}).kind, 'kill-by-name');
  assert.equal(processGuard({ tool_name: 'Bash', tool_input: {} }, {}), null);
});

// --- hook level (spawns hooks/poll-guard.mjs) ---------------------------------------------------
const hook = (tool_name, command, env = {}) =>
  runHook('hooks/poll-guard.mjs', { tool_name, tool_input: { command }, session_id: 's-pk' }, { env });

test('hook: Bash pkill is denied with the replacement text', () => {
  const r = hook('Bash', 'pkill -f vite');
  assert.equal(decisionOf(r.json), 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /kill that PID only/);
});
test('hook: PowerShell Stop-Process -Name is denied; -Id passes', () => {
  assert.equal(decisionOf(hook('PowerShell', 'Stop-Process -Name node').json), 'deny');
  assert.notEqual(decisionOf(hook('PowerShell', 'Stop-Process -Id 123').json), 'deny');
});
test('hook: taskkill /IM denied, taskkill /PID passes', () => {
  assert.equal(decisionOf(hook('Bash', 'taskkill /F /IM node.exe').json), 'deny');
  assert.notEqual(decisionOf(hook('Bash', 'taskkill /F /PID 123').json), 'deny');
});
test('hook: echo and grep arguments pass', () => {
  assert.notEqual(decisionOf(hook('Bash', 'echo "taskkill /IM node.exe"').json), 'deny');
  assert.notEqual(decisionOf(hook('Bash', 'grep -rn pkill docs').json), 'deny');
});
test('hook: kill_by_name_guard=off lets the kill through; warn adds a note without denying', () => {
  const off = hook('Bash', 'pkill node', { CLAUDE_PLUGIN_OPTION_KILL_BY_NAME_GUARD: 'off' });
  assert.notEqual(decisionOf(off.json), 'deny');
  const warn = hook('Bash', 'pkill node', { CLAUDE_PLUGIN_OPTION_KILL_BY_NAME_GUARD: 'warn' });
  assert.notEqual(decisionOf(warn.json), 'deny');
  assert.match(warn.json.hookSpecificOutput.additionalContext, /Never kill a process by image name/);
});
test('hook: the default is on', () => {
  const env = { CLAUDE_PLUGIN_OPTION_KILL_BY_NAME_GUARD: '' };
  assert.equal(decisionOf(hook('Bash', 'killall node', env).json), 'deny');
});
test('hook: claude plugin uninstall is denied and the switch does not reach it', () => {
  const r = hook('Bash', 'claude plugin uninstall agent-companion@agent-templates', { CLAUDE_PLUGIN_OPTION_KILL_BY_NAME_GUARD: 'off' });
  assert.equal(decisionOf(r.json), 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /marketplace update/);
  assert.equal(decisionOf(hook('PowerShell', 'claude plugin uninstall x').json), 'deny');
  assert.notEqual(decisionOf(hook('Bash', 'claude plugin update agent-companion@agent-templates').json), 'deny');
});
