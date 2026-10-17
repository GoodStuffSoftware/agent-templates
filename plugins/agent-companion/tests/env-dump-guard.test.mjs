// env_dump_guard (0.31.25): bulk environment-value dumps and prints of secret-named variables.
// Pure check in-process (hooks/lib/env-dump-guard.mjs); hook-level tests spawn hooks/poll-guard.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { runHook, decisionOf } from './helpers.mjs';
import { envDumpHits, envDumpGuard, ENV_MSG } from '../hooks/lib/env-dump-guard.mjs';

const NL = '\n';
const hit = (cmd, shell = 'bash') => envDumpHits(cmd, shell).env;

const DENY_BASH = [
  'env',
  'env | grep -i claude',
  'env | grep CLAUDE_CODE',
  'env | sort',
  'env | head',
  'env -0',
  'printenv',
  'printenv | grep -i token',
  'set',
  'set | grep CLAUDE',
  'export -p',
  'export',
  'export -p | grep claude',
  'declare -x',
  'declare -p',
  'declare -xp',
  'declare',
  'typeset -x',
  'sudo env',
  'cd /tmp && env',
  'echo start; printenv',
  'FOO=1 env',
  'printenv CLAUDE_CODE_MESSAGING_TOKEN',
  'printenv GITHUB_TOKEN',
  'printenv API_KEY',
  'printenv AWS_SECRET_ACCESS_KEY',
  'printenv DB_PASSWORD',
  'printenv MY_PASSWD',
  'printenv OAUTH_TOKEN',
  'printenv AUTH_HEADER',
  'printenv SESSION_COOKIE',
  'printenv GOOGLE_CREDENTIALS',
  'echo $CLAUDE_CODE_MESSAGING_TOKEN',
  'echo "$GITHUB_TOKEN"',
  'echo "${GITHUB_TOKEN}"',
  'echo "token=${API_KEY}"',
  'echo ${SECRET_VALUE}',
  'echo $DB_PASSWORD',
  'echo $MY_PASSWD',
  'echo $AUTH_TOKEN',
  'echo "$SESSION_COOKIE"',
  'echo $AWS_CREDENTIALS',
  'echo "key: $STRIPE_KEY"',
  'echo $API_KEY | tr a-z A-Z',
  'printf "%s\\n" "$GITHUB_TOKEN"',
  'printf "%s" $OPENAI_API_KEY',
  'echo "${TOKEN:-default}"',
  'declare -p GITHUB_TOKEN',
  'bash -c "env | grep claude"',
  "sh -c 'printenv'",
  'bash -lc "echo $GITHUB_TOKEN"',
  'eval "env"',
  'cmd /c set',
  'powershell -Command "Get-ChildItem env:"',
  "powershell -NoProfile -Command 'gci env: | Where-Object { $_.Name -like \"*CLAUDE*\" }'",
  'x=$(env); echo hi; env',
  'cat /proc/self/environ',
  'strings /proc/1234/environ',
  'tr "\\0" "\\n" < /proc/self/environ',
  `echo hi${NL}env${NL}echo done`,
  'env && echo ok',
  'nohup env &',
];
const DENY_PS = [
  'Get-ChildItem env:',
  'Get-ChildItem Env:',
  'Get-ChildItem Env:\\',
  'Get-ChildItem -Path env:',
  'gci env:',
  'gci env:*',
  'ls env:',
  'dir env:',
  'Get-Item env:*',
  'gi env:*TOKEN*',
  'gci env: | Where-Object { $_.Name -like "*CLAUDE*" }',
  'gci env: | Where-Object Name -match claude',
  'gci env: | Sort-Object Name',
  'gci env: | Format-Table -AutoSize',
  'gci env: | Select-Object Name, Value',
  'gci env: | Select-Object -ExpandProperty Value',
  'gci env: | ForEach-Object { "$($_.Name)=$($_.Value)" }',
  'gci env: | Out-String',
  '[Environment]::GetEnvironmentVariables()',
  '[System.Environment]::GetEnvironmentVariables()',
  '[Environment]::GetEnvironmentVariables() | Format-List',
  '[Environment]::GetEnvironmentVariables("Machine")',
  '$env:CLAUDE_CODE_MESSAGING_TOKEN',
  '$env:GITHUB_TOKEN',
  '${env:API_KEY}',
  '$env:GitHubToken',
  'Write-Host $env:GITHUB_TOKEN',
  'Write-Output $env:API_KEY',
  'Write-Host "token: $env:GITHUB_TOKEN"',
  'echo $env:DB_PASSWORD',
  'Get-Item env:GITHUB_TOKEN',
  'gi env:API_KEY',
  'Get-Content env:SECRET_VALUE',
  'gc env:GITHUB_TOKEN',
  'printenv GITHUB_TOKEN',
  '[Environment]::GetEnvironmentVariable("GITHUB_TOKEN")',
  'cmd /c set',
  'powershell -Command "gci env:"',
  'Invoke-Expression "gci env:"',
  '& gci env:',
  'if ($true) { gci env: }',
];
const ALLOW_BASH = [
  'env | cut -d= -f1',
  'env | cut -d= -f1 | sort',
  "env | cut -d '=' -f 1",
  'env | cut --delimiter== --fields=1',
  "printenv | sed 's/=.*//'",
  "printenv | sed -E 's/=.*$//'",
  "env | awk -F= '{print $1}'",
  "env | grep -o '^[^=]*'",
  'env | grep -i claude | cut -d= -f1',
  'env | grep -q CLAUDE',
  'env | grep -c CLAUDE',
  'env | grep -qi claude && echo present',
  'env | wc -l',
  'printenv | sha256sum',
  'compgen -e',
  'compgen -e | grep -i claude',
  'compgen -v',
  'env > /tmp/env.txt',
  'env >/dev/null',
  'printenv 2>/dev/null | cut -d= -f1',
  'env FOO=1 node script.js',
  'env -i PATH=/bin ls',
  'env -u HOME bash -c "echo hi"',
  'env NODE_ENV=test npm test',
  'FOO=1 env BAR=2 make',
  'set -e',
  'set -euo pipefail',
  'set +x',
  'set -- a b c',
  'export FOO=bar',
  'export PATH="$PATH:/x"',
  'export FOO',
  'export -n FOO',
  'declare -a arr=(1 2)',
  'declare -f myfunc',
  'declare FOO=1',
  'typeset -i n=3',
  'printenv HOME',
  'printenv PATH',
  'printenv USER SHELL',
  'printenv EDITOR',
  'echo $HOME',
  'echo "$PATH"',
  'echo ${USER}',
  'echo $key',
  'echo "$token" ',
  'echo "$secret_name"',
  'echo $keyboard',
  'echo $MONKEYS',
  'echo $AUTHOR',
  'echo "${TOKEN:+set}"',
  'echo "${API_KEY+set}"',
  'echo "${#GITHUB_TOKEN}"',
  '[ -n "$GITHUB_TOKEN" ] && echo set || echo unset',
  '[ -z "$API_KEY" ] && echo unset',
  'test -n "$GITHUB_TOKEN"',
  'if [ -n "$NPM_TOKEN" ]; then echo ok; fi',
  'echo $GITHUB_TOKEN | wc -c',
  'echo $GITHUB_TOKEN | sha256sum',
  "echo '$GITHUB_TOKEN'",
  'echo "\\$GITHUB_TOKEN"',
  'echo "env | grep claude"',
  "echo 'printenv GITHUB_TOKEN'",
  'echo env',
  'grep -rn "printenv" docs',
  'grep "env | grep" notes.md',
  'rg -n "export -p" .',
  'git commit -m "deny env | grep and printenv TOKEN"',
  'git log --grep="env dump"',
  'cat env.example',
  'cat .env.example',
  'cat <<\'E\'' + NL + 'env' + NL + 'echo $GITHUB_TOKEN' + NL + 'E',
  'cat > notes.md <<EOF' + NL + 'run printenv GITHUB_TOKEN' + NL + 'EOF',
  '# env',
  'ls # printenv',
  'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user',
  'curl -s -H "X-Api-Key: $API_KEY" https://example.com',
  'gh auth status',
  'gh api user --header "Authorization: token $GITHUB_TOKEN"',
  'git push https://x:$GITHUB_TOKEN@github.com/o/r.git',
  'node -e "process.exit(0)"',
  'node scripts/env-report.mjs',
  'npm run env',
  'x=$(env | cut -d= -f1)',
  'files=$(ls); echo $files',
  'envsubst < tpl > out',
  'bash -c "env | cut -d= -f1"',
  "sh -c 'printenv HOME'",
  'bash -c "echo $HOME"',
  'cmd /c "echo %PATH%"',
  'cat /proc/self/status',
  'cat /proc/self/environment-notes.md',
  'tr "\\0" "\\n" < /proc/self/environ | cut -d= -f1',
  'printenv | sed \'s/=.*//\' | sort',
  'which env',
  'ls -la env',
  'echo done',
];
const ALLOW_PS = [
  '(Get-ChildItem env:).Name',
  '(gci env:).Name',
  '(Get-ChildItem Env:).Name | Sort-Object',
  '(Get-ChildItem env:).Key',
  'gci env: | Select-Object -ExpandProperty Name',
  'gci env: | Select-Object Name',
  'gci env: | Select Name',
  'Get-ChildItem env: | ForEach-Object { $_.Name }',
  'Get-ChildItem env: | % Name',
  'gci env: | Sort-Object Name | Select-Object -ExpandProperty Name',
  'gci env: | Measure-Object',
  '[Environment]::GetEnvironmentVariables().Keys',
  '[System.Environment]::GetEnvironmentVariables().Keys | Sort-Object',
  'if ($env:GITHUB_TOKEN) { "set" } else { "unset" }',
  'if ($null -ne $env:API_KEY) { Write-Host "set" }',
  '$env:GITHUB_TOKEN.Length',
  '$env:PATH',
  '$env:HOME',
  '$env:USERPROFILE',
  'Write-Host $env:USERPROFILE',
  'Write-Output "home: $env:HOME"',
  'echo $env:CLAUDE_CODE_ENTRYPOINT',
  'Get-Item env:PATH',
  'gi env:HOME',
  'Get-Content env:USERPROFILE',
  '$env:FOO = "bar"',
  '$env:GITHUB_TOKEN = "x"',
  'Remove-Item env:FOO',
  'Set-Item env:FOO bar',
  'Get-ChildItem C:\\Users',
  'ls C:\\Users',
  'dir',
  'Get-ChildItem -Path . -Recurse',
  'Get-Item README.md',
  'Get-Content notes.txt',
  'Write-Host "env: is a PSDrive"',
  'Write-Host \'gci env:\'',
  'Select-String -Pattern "Get-ChildItem env:" -Path *.md',
  'echo "gci env:"',
  '# gci env:',
  'Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:GITHUB_TOKEN" } https://api.github.com/user',
  '$p = Start-Process node -PassThru',
  'Get-Process node',
  'set',
];
const SETTLED_PS_DENY_NOTE = 0;
void SETTLED_PS_DENY_NOTE;

for (const c of DENY_BASH) test(`env dump denied (bash): ${JSON.stringify(c).slice(0, 90)}`, () => assert.ok(hit(c, 'bash'), c));
for (const c of DENY_PS) test(`env dump denied (powershell): ${JSON.stringify(c).slice(0, 90)}`, () => assert.ok(hit(c, 'powershell'), c));
for (const c of ALLOW_BASH) test(`env rule allows (bash): ${JSON.stringify(c).slice(0, 90)}`, () => assert.equal(hit(c, 'bash'), null, c));
for (const c of ALLOW_PS) test(`env rule allows (powershell): ${JSON.stringify(c).slice(0, 90)}`, () => assert.equal(hit(c, 'powershell'), null, c));

test('the deny text gives the names-only form and the presence test', () => {
  assert.match(ENV_MSG, /env \| cut -d= -f1/);
  assert.match(ENV_MSG, /compgen -e/);
  assert.match(ENV_MSG, /\(Get-ChildItem env:\)\.Name/);
  assert.match(ENV_MSG, /\[ -n "\$NAME" \]/);
  assert.match(ENV_MSG, /env_dump_guard/);
});

test('never throws on odd input', () => {
  for (const v of [undefined, null, '', ' ', '"', "'", '$(', '`', '((((', '))))', '<<', '<<E', 'echo ${', 'echo $(', 'gci env:\\', 'printenv "']) {
    assert.doesNotThrow(() => envDumpHits(v, 'bash'));
    assert.doesNotThrow(() => envDumpHits(v, 'powershell'));
  }
});

test('envDumpGuard: mode switches the rule', () => {
  const payload = (command, tool_name = 'Bash') => ({ tool_name, tool_input: { command } });
  assert.equal(envDumpGuard(payload('env | grep claude'), {}).mode, 'deny');
  assert.equal(envDumpGuard(payload('env | grep claude'), { mode: 'deny' }).mode, 'deny');
  assert.equal(envDumpGuard(payload('env | grep claude'), { mode: 'warn' }).mode, 'warn');
  assert.equal(envDumpGuard(payload('env | grep claude'), { mode: 'off' }), null);
  assert.equal(envDumpGuard(payload('env | grep claude'), { mode: 'OFF' }), null);
  assert.equal(envDumpGuard(payload('env | cut -d= -f1'), {}), null);
  assert.equal(envDumpGuard(payload('gci env:', 'PowerShell'), {}).kind, 'env-dump');
  assert.equal(envDumpGuard({ tool_name: 'Bash', tool_input: {} }, {}), null);
});

test('the recorded detail never carries a value', () => {
  const r = envDumpGuard({ tool_name: 'Bash', tool_input: { command: 'echo $GITHUB_TOKEN' } }, {});
  assert.ok(!/ghp_|=/.test(r.detail));
});

// --- hook level ---------------------------------------------------------------------------------
const hook = (tool_name, command, env = {}) =>
  runHook('hooks/poll-guard.mjs', { tool_name, tool_input: { command }, session_id: 's-env' }, { env });

test('hook: env | grep is denied with the names-only text', () => {
  const r = hook('Bash', 'env | grep -i claude');
  assert.equal(decisionOf(r.json), 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /cut -d= -f1/);
});
test('hook: names-only forms pass', () => {
  assert.notEqual(decisionOf(hook('Bash', 'env | cut -d= -f1').json), 'deny');
  assert.notEqual(decisionOf(hook('Bash', 'compgen -e').json), 'deny');
  assert.notEqual(decisionOf(hook('PowerShell', '(Get-ChildItem env:).Name').json), 'deny');
});
test('hook: PowerShell env: listing and a secret $env: print are denied', () => {
  assert.equal(decisionOf(hook('PowerShell', 'Get-ChildItem env:').json), 'deny');
  assert.equal(decisionOf(hook('PowerShell', '$env:GITHUB_TOKEN').json), 'deny');
});
test('hook: echo of a secret-named variable is denied, a plain one passes', () => {
  assert.equal(decisionOf(hook('Bash', 'echo $CLAUDE_CODE_MESSAGING_TOKEN').json), 'deny');
  assert.notEqual(decisionOf(hook('Bash', 'echo $HOME').json), 'deny');
});
test('hook: env_dump_guard=off passes; warn adds a note; the default is on', () => {
  const off = hook('Bash', 'printenv', { CLAUDE_PLUGIN_OPTION_ENV_DUMP_GUARD: 'off' });
  assert.notEqual(decisionOf(off.json), 'deny');
  const warn = hook('Bash', 'printenv', { CLAUDE_PLUGIN_OPTION_ENV_DUMP_GUARD: 'warn' });
  assert.notEqual(decisionOf(warn.json), 'deny');
  assert.match(warn.json.hookSpecificOutput.additionalContext, /environment variable VALUES/);
  assert.equal(decisionOf(hook('Bash', 'printenv', { CLAUDE_PLUGIN_OPTION_ENV_DUMP_GUARD: '' }).json), 'deny');
});
