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
  "env | sed 's/=.*/&/'", // & re-emits the match
  "env | sed 's/=.*/x&/'",
  "env | sed -E 's/=(.*)/=\\1/'",
  "env | sed 's/=.*/\\0/'",
  "env | sed 's/=.*/x/e'", // e runs the line
  "env | sed 's.=.*.#.'", // delimiter inside the match: sed splits the script elsewhere and the value comes back
  "env | sed 's*=.**#*'",
  'env | sed \'s$=.*$$;e env #$\'',
  "env | sed 's=.*=x='",
  'env | sed "s/=.*/$(printf \'&\')/"', // the shell expands $(...) before sed runs
  'env | sed "s/=.*/`printf \'&\'`/"',
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
  // env -S STRING, judged like the words it splits into
  'env -S "printenv"',
  'env -S printenv',
  'env -S env',
  "env -S 'FOO=1 printenv'",
  'env -S "-i printenv"',
  'env -iS printenv',
  'env --split-string=printenv',
  'env -S "printenv GITHUB_TOKEN"',
  'env -S ""',
  'env -S "FOO=1"',
  // env -S STRING with a nested shell, eval, xargs or inline program inside the string (0.31.29 review A: a regression)
  'env -S "bash -c env"',
  'env -S "bash -c printenv"',
  "env -S 'sh -c env'",
  '/usr/bin/env -S "bash -c env"',
  'env -S "eval env"',
  'env -S "xargs env"',
  'env -S "node -e \\"console.log(process.env)\\""',
  'env -S "python3 -c \\"import os; print(os.environ)\\""',
  `env -S "awk 'BEGIN{for(k in ENVIRON) print k, ENVIRON[k]}'"`,
  `env -S "bash -c 'env | grep X'"`,
  `env -S 'bash -c "printenv GITHUB_TOKEN"'`,
  'env -S "-i bash -c env"',
  'env -u FOO -S "bash -c env"',
  // the direct dump forms inside the string
  'env -Sprintenv',
  'env -vS printenv',
  'env -u FOO -S printenv',
  'env -C /tmp -S printenv',
  'env -S "set"',
  'env -S "export -p"',
  'env -S "sudo printenv"',
  'env -S "time env"',
  'env -S "exec env"',
  'env -S "cat /proc/self/environ"',
  'env -S "printenv ANTHROPIC_API_KEY"',
  // env as a prefix before a nested shell or inline program (old gap)
  'env bash -c env',
  'env sh -c printenv',
  'env -i bash -c env',
  'env FOO=1 bash -c "env"',
  'env -u X sh -c env',
  'env node -e "console.log(process.env)"',
  'xargs env',
  'echo a | xargs -n1 printenv',
  `awk 'BEGIN{for(k in ENVIRON) print k, ENVIRON[k]}'`,
  `awk 'BEGIN{print ENVIRON["API_KEY"]}'`,
  'env printenv',
  'env FOO=1 printenv',
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
  // env -S STRING: the string is split into the words it stands for; a benign command stays allowed
  'env -S "ls -l"',
  'env -S "FOO=1 ls"',
  "env -S 'node script.js'",
  'env --split-string="echo hi"',
  'env -S "printenv HOME"',
  'env -S "printenv PATH"',
  'env -S "npm test"',
  'env -S "node build.js"',
  'env -S "env" | wc -l',
  `env -S "bash -c 'echo hi'"`,
  'env -S "xargs ls"',
  'env -S "eval echo hi"',
  'env bash -c "echo hi"',
  'env FOO=1 npm test',
  'env sh script.sh',
  'xargs ls',
  'echo a | xargs -n1 echo',
  `awk 'BEGIN{print ENVIRON["HOME"]}'`,
  `awk 'BEGIN{print length(ENVIRON)}'`,
  'env | cut -d= -f1',
  'env | cut -d= -f1 | sort',
  "env | cut -d '=' -f 1",
  'env | cut --delimiter== --fields=1',
  "printenv | sed 's/=.*//'",
  "printenv | sed -E 's/=.*$//'",
  "env | grep -i -E 'firebase|google|gcloud|GITHUB|GH_' | sed 's/=.*/=…/'",
  "printenv | sed 's|=.*|=<hidden>|g'",
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
// 0.31.28 review (A1): after the call operator a quoted first word is the program, not a string value
const GIT_BIN = 'C:\\Program Files\\Git\\usr\\bin';
const CALL_DENY_PS = [
  `& '${GIT_BIN}\\env.exe'`,
  `& "${GIT_BIN}\\printenv.exe"`,
  `& '${GIT_BIN}\\printenv.exe' FAKE_SVC_TOKEN`,
  "& 'env'",
  '& "env"',
  `&'${GIT_BIN}\\env.exe'`,
  `& '${GIT_BIN}\\env.exe' | Out-String`,
  `$x = & '${GIT_BIN}\\env.exe'; $x`,
  "& 'C:\\Git\\usr\\bin\\env.exe'",
  '& C:\\Git\\usr\\bin\\env.exe',
];
const CALL_ALLOW_PS = [
  `'${GIT_BIN}\\env.exe'`,
  `"${GIT_BIN}\\printenv.exe"`,
  `& '${GIT_BIN}\\printenv.exe' HOME`,
  `& '${GIT_BIN}\\env.exe' > env-names.txt`,
  `& '${GIT_BIN}\\env.exe' | Measure-Object`,
];
for (const c of CALL_DENY_PS) test(`call operator, env dump denied (powershell): ${JSON.stringify(c).slice(0, 90)}`, () => assert.ok(hit(c, 'powershell'), c));
for (const c of CALL_ALLOW_PS) test(`call operator, env rule allows (powershell): ${JSON.stringify(c).slice(0, 90)}`, () => assert.equal(hit(c, 'powershell'), null, c));

// 0.31.28 review (N3): a PowerShell dot-source of a program path runs it like the call operator. Every deny below was
// allowed before the review fix; a bare quoted path string is still a string value.
const DOT_DENY_PS = [
  `. '${GIT_BIN}\\env.exe'`,
  `. "${GIT_BIN}\\env.exe"`,
  `. "${GIT_BIN}\\printenv.exe" FAKE_SVC_TOKEN`,
  `.  '${GIT_BIN}\\printenv.exe'`,
  `.'${GIT_BIN}\\env.exe'`,
  `. '${GIT_BIN}\\env.exe' | Out-String`,
  `cd C:\\; . '${GIT_BIN}\\env.exe'`,
  `$x = . '${GIT_BIN}\\env.exe'; $x`,
  `if ($true) { . '${GIT_BIN}\\env.exe' }`,
  '. env',
  '. C:\\Git\\usr\\bin\\env.exe',
];
const DOT_ALLOW_PS = [
  `'${GIT_BIN}\\env.exe'`,
  `"${GIT_BIN}\\printenv.exe"`,
  `. "${GIT_BIN}\\printenv.exe" HOME`,
  `. '${GIT_BIN}\\env.exe' > env-names.txt`,
  `. '${GIT_BIN}\\env.exe' | Measure-Object`,
  '. .\\scripts\\setup.ps1',
  '. $PROFILE',
  `$x = . '${GIT_BIN}\\printenv.exe' HOME`,
  '$x = . .\\lib.ps1',
  '.\\run.ps1 -Name x',
  "Write-Output '. env'",
];
for (const c of DOT_DENY_PS) test(`dot-source, env dump denied (powershell): ${JSON.stringify(c).slice(0, 90)}`, () => assert.ok(hit(c, 'powershell'), c));
for (const c of DOT_ALLOW_PS) test(`dot-source, env rule allows (powershell): ${JSON.stringify(c).slice(0, 90)}`, () => assert.equal(hit(c, 'powershell'), null, c));
for (const c of ['. ./env.sh', '. ~/.bashrc']) test(`bash source, env rule allows: ${c}`, () => assert.equal(hit(c, 'bash'), null, c));

// 0.31.28 review (A4): a redirection to the screen is not a file. Every deny below was allowed before the review fix.
const SCREEN_DENY = [
  ['bash', 'env > /dev/stdout'],
  ['bash', 'env >/dev/stdout'],
  ['bash', 'env 1>/dev/stdout'],
  ['bash', 'env >> /dev/stdout'],
  ['bash', 'env > "/dev/stdout"'],
  ['bash', 'printenv > /dev/stderr'],
  ['bash', 'env > /dev/tty'],
  ['bash', 'env > /dev/fd/1'],
  ['bash', 'env > /dev/fd/2'],
  ['bash', 'env > /proc/self/fd/1'],
  ['bash', 'env > /proc/self/fd/2'],
  ['bash', 'env > >(cat)'],
  ['bash', 'env &> /dev/tty'],
  ['bash', 'env &>/dev/stdout'],
  ['bash', 'printenv FAKE_SVC_TOKEN > /dev/tty'],
  ['bash', 'echo $FAKE_SVC_TOKEN > /dev/stdout'],
  ['bash', 'node -e "console.log(process.env)" > /dev/stdout'],
  ['bash', 'node -e "console.log(process.env)" > >(cat)'],
  ["bash", "node -e 'console.error(process.env)' 2> /dev/stderr"],
  ["bash", "node -e 'console.error(process.env)' 2>/dev/tty"],
  ['powershell', 'Get-ChildItem env: > CON'],
  ['powershell', 'gci env: >CON'],
  ['powershell', 'gci env: > con:'],
  ['powershell', 'gci env: *> CON'],
  ['powershell', '$env:FAKE_SVC_TOKEN > CON'],
  // *>&1 merges every stream into stdout: it used to count as "all streams to a file"; it stays on the screen
  ['powershell', 'gci env: *>&1'],
  ['powershell', 'Get-ChildItem env: *>&1 | Out-String'],
];
const SCREEN_ALLOW = [
  ['bash', 'env > /dev/null'],
  ['bash', 'env > out.txt'],
  ['bash', 'env > out.txt 2>&1'],
  ['bash', 'env &> out.txt'],
  ['bash', 'env > /dev/stdout.txt'],
  ['bash', 'env > console.log'],
  ['bash', 'env > /dev/fd/3'],
  ['bash', 'printenv FAKE_SVC_TOKEN > token-check.txt'],
  ["bash", "node -e 'console.error(process.env)' 2> /tmp/err.txt"],
  ["bash", "node -e 'console.log(process.env)' > /tmp/o.txt"],
  ['powershell', 'gci env: > $null'],
  ['powershell', 'gci env: > contacts.txt'],
  ['powershell', 'gci env: *> out.txt'],
  ['powershell', '$env:FAKE_SVC_TOKEN > token-check.txt'],
];
for (const [shell, c] of SCREEN_DENY) test(`screen target, env dump denied (${shell}): ${JSON.stringify(c).slice(0, 90)}`, () => assert.ok(hit(c, shell), c));
for (const [shell, c] of SCREEN_ALLOW) test(`file target, env rule allows (${shell}): ${JSON.stringify(c).slice(0, 90)}`, () => assert.equal(hit(c, shell), null, c));

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

// --- inline programs (0.31.28): node / bun / deno / python code, stdin programs, -EncodedCommand ---------------------
// Every command below is a test string only: the guard parses it, nothing runs it.
const D = '$';
const bq = (code) => `'${code.replace(/'/g, `'\\''`)}'`; // bash single quotes
const bdq = (code) => `"${code.replace(/[\\"$`]/g, '\\$&')}"`; // bash double quotes
const pq = (code) => `'${code.replace(/'/g, "''")}'`; // PowerShell single quotes
const pdq = (code) => `"${code.replace(/[`"$]/g, '`$&')}"`; // PowerShell double quotes, backtick escapes
const enc = (script) => Buffer.from(script, 'utf16le').toString('base64'); // -EncodedCommand payload

const jsBash = (code) => [
  `node -e ${bq(code)}`,
  `node --eval ${bdq(code)}`,
  `node --eval=${bq(code)}`,
  `node - <<'E'${NL}${code}${NL}E`,
  `node <<< ${bq(code)}`,
  `cat <<'E' | node${NL}${code}${NL}E`,
  `echo ${bq(code)} | node -`,
  `bun -e ${bq(code)}`,
  `deno eval ${bq(code)}`,
  `npx node -e ${bq(code)}`,
];
const jsPs = (code) => [`node -e ${pq(code)}`, `node -e ${pdq(code)}`, `${pq(code)} | node -`, `@'${NL}${code}${NL}'@ | node -`];
const jsPrintBash = (code) => [`node -p ${bq(code)}`, `node --print ${bdq(code)}`, `node -pe ${bq(code)}`, `deno eval -p ${bq(code)}`];
const jsPrintPs = (code) => [`node -p ${pq(code)}`, `node -p ${pdq(code)}`];
const pyBash = (code) => [
  `python -c ${bq(code)}`,
  `python3 -c ${bdq(code)}`,
  `py -3 -c ${bq(code)}`,
  `pypy3 -c ${bq(code)}`,
  `python3 -I -c ${bq(code)}`,
  `python3 - <<'E'${NL}${code}${NL}E`,
  `python3 <<< ${bq(code)}`,
  `cat <<'E' | python3 -${NL}${code}${NL}E`,
  `echo ${bq(code)} | python3`,
  `uv run python -c ${bq(code)}`,
];
const pyPs = (code) => [`python -c ${pq(code)}`, `py -c ${pdq(code)}`, `${pq(code)} | python -`, `@'${NL}${code}${NL}'@ | python -`];

const JS_DUMP = [
  'console.log(process.env)',
  'console.log(JSON.stringify(process.env, null, 2))',
  'console.log(Object.entries(process.env))',
  'console.table(process.env)',
  'console.dir(process.env)',
  'console.error(process.env)',
  'process.stdout.write(JSON.stringify(process.env))',
  'for (const k in process.env) console.log(k, process.env[k])',
  'for (const [k, v] of Object.entries(process.env)) console.log(`${k}=${v}`)',
  'const e = process.env; console.log(e)',
  'const { env } = process; console.log(env)',
  'console.log({ ...process.env })',
  "console.log(process['env'])",
  "console.log(require('process').env)",
  "console.log(require('util').inspect(process.env))",
  'Object.keys(process.env).forEach((k) => console.log(k + "=" + process.env[k]))',
];
const JS_SECRET = [
  'console.log(process.env.GITHUB_TOKEN)',
  "console.log(process.env['API_KEY'])",
  'console.log(process.env["CLAUDE_CODE_MESSAGING_TOKEN"])',
  'const t = process.env.GITHUB_TOKEN; console.log(t)',
  'const { GITHUB_TOKEN } = process.env; console.log(GITHUB_TOKEN)',
  'console.log(`tok=${process.env.GITHUB_TOKEN}`)',
  'console.log("pw: " + process.env.DB_PASSWORD)',
  'process.stdout.write(process.env.OPENAI_API_KEY)',
];
const JS_ALLOW = [
  'console.log(process.env.PATH)',
  'console.log(process.env.HOME)',
  "console.log(process.env['USERPROFILE'])",
  "console.log('GITHUB_TOKEN' in process.env)",
  'console.log(!!process.env.GITHUB_TOKEN)',
  "console.log(process.env.GITHUB_TOKEN ? 'set' : 'unset')",
  'console.log(typeof process.env.API_KEY)',
  'console.log(Boolean(process.env.API_KEY))',
  'console.log((process.env.GITHUB_TOKEN || "").length)',
  'console.log(Object.keys(process.env))',
  'console.log(Object.keys(process.env).filter((k) => /CLAUDE/.test(k)).join("\\n"))',
  'console.log(Object.keys(process.env).length)',
  // 0.31.28 review (N2): counts of the env object print no value
  'console.log(Object.entries(process.env).length)',
  'console.log(Object.values(process.env).length)',
  'console.log(JSON.stringify(process.env).length)',
  'console.log(Object.entries({ ...process.env }).length)',
  "fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } }).then((r) => console.log(r.status))",
  "require('child_process').execSync('git status', { env: { ...process.env, FOO: '1' }, stdio: 'inherit' })",
  'process.exit(0)',
  "console.log('hello')",
];
const JS_PRINT_DENY = ['process.env', 'JSON.stringify(process.env)', 'process.env.GITHUB_TOKEN', "process.env['API_KEY']", 'Object.entries(process.env)'];
const JS_PRINT_ALLOW = ['process.env.PATH', 'Object.keys(process.env)', "'GITHUB_TOKEN' in process.env", '!!process.env.API_KEY', 'process.versions.node',
  'Object.entries(process.env).length'];

const PY_DUMP = [
  'import os; print(os.environ)',
  'import os; print(dict(os.environ))',
  'import os, json; print(json.dumps(dict(os.environ), indent=2))',
  `import os${NL}for k, v in os.environ.items(): print(k, v)`,
  `import os${NL}for k in os.environ: print(k, os.environ[k])`,
  'import os; [print(k, os.getenv(k)) for k in os.environ]',
  'from os import environ; print(environ)',
  'from os import environ as E; print(E)',
  'import os, sys; sys.stdout.write(str(os.environ))',
  'import os, pprint; pprint.pprint(dict(os.environ))',
  'import os; e = os.environ.copy(); print(e)',
  'import os; print({**os.environ})',
  'import os; print(list(os.environ.items()))',
];
const PY_SECRET = [
  "import os; print(os.environ['GITHUB_TOKEN'])",
  "import os; print(os.getenv('API_KEY'))",
  'import os; print(os.environ.get("CLAUDE_CODE_MESSAGING_TOKEN"))',
  'import os; t = os.environ["GITHUB_TOKEN"]; print(t)',
  `import os; print(f"tok={os.environ['GITHUB_TOKEN']}")`,
  "import os, sys; sys.stdout.write(os.environ['DB_PASSWORD'])",
];
const PY_ALLOW = [
  "import os; print(os.environ.get('HOME'))",
  "import os; print(os.environ['PATH'])",
  "import os; print('GITHUB_TOKEN' in os.environ)",
  "import os; print(bool(os.getenv('GITHUB_TOKEN')))",
  "import os; print(os.getenv('GITHUB_TOKEN') is not None)",
  "import os; print(len(os.environ.get('API_KEY', '')))",
  'import os; print(sorted(os.environ))',
  'import os; print(list(os.environ.keys()))',
  'import os; print(len(os.environ))',
  `import os${NL}for k in os.environ: print(k)`,
  "import os, subprocess; subprocess.run(['git', 'status'], env=os.environ.copy())",
  "import os, urllib.request; r = urllib.request.urlopen(urllib.request.Request('https://api.github.com/user', headers={'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN']})); print(r.status)",
  'print(1)',
];
// a command run from inside the code goes back through the guard as a bash command
const JS_NESTED_DENY = [
  "require('child_process').execSync('env', { stdio: 'inherit' })",
  "console.log(require('child_process').execSync('printenv').toString())",
  "require('child_process').execSync('echo $GITHUB_TOKEN', { stdio: 'inherit' })",
  "require('child_process').spawnSync('printenv', { stdio: 'inherit' })",
  "const { execSync } = require('child_process'); console.log(String(execSync('env | grep -i claude')))",
  // 0.31.28 review (A3): bare exec( and a template literal with no ${} part
  'require("child_process").exec("env", (e, o) => console.log(o))',
  "const { exec } = require('child_process'); exec('printenv', (e, o) => console.log(o));",
  'console.log(require("child_process").execSync(`env`).toString())',
  "console.log(require('child_process').execSync(`printenv`).toString())",
  "require('child_process').exec(`printenv FAKE_SVC_TOKEN`, (e, o) => console.log(o))",
];
const JS_NESTED_ALLOW = [
  "require('child_process').execSync('git status', { stdio: 'inherit' })",
  "require('child_process').execSync('env | cut -d= -f1', { stdio: 'inherit' })",
  "console.log(require('child_process').execSync('node --version').toString())",
  "require('child_process').exec('git status', (e, o) => console.log(o))",
  "console.log(require('child_process').execSync(`git status`).toString())",
  "console.log(/env/.exec('environment'))",
  'console.log(`no interpolation here`)',
];
const PY_NESTED_DENY = [
  "import os; os.system('env')",
  "import os; print(os.popen('printenv').read())",
  "import subprocess; subprocess.run('env', shell=True)",
  "import subprocess; print(subprocess.check_output('printenv GITHUB_TOKEN', shell=True))",
];
const PY_NESTED_ALLOW = [
  "import os; os.system('git status')",
  "import subprocess; subprocess.run(['git', 'status'], check=True)",
  "import os; os.system('env | cut -d= -f1')",
  // 0.31.28 review (N2): output captured and nothing printed; counts of the env object
  "import subprocess; subprocess.run(['env'], capture_output=True)",
  "import subprocess; r = subprocess.run('printenv', shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
  "import subprocess; subprocess.run(['env'], stdout=subprocess.DEVNULL)",
  "import subprocess; out = subprocess.check_output(['printenv'])",
  'import os; print(len(os.environ.items()))',
  'import os; print(len(dict(os.environ)))',
  'import os, json; print(len(json.dumps(dict(os.environ))))',
];
const PY_CAPTURE_DENY = [
  "import subprocess; r = subprocess.run(['env'], capture_output=True); print(r.stdout)",
  "import subprocess; print(subprocess.run(['env'], capture_output=True, text=True).stdout)",
  "import subprocess; subprocess.run(['env'])",
  "import subprocess; subprocess.run('printenv FAKE_SVC_TOKEN >&2', shell=True, stdout=subprocess.PIPE)",
  "import subprocess, sys; sys.stdout.write(subprocess.check_output(['printenv']).decode())",
  "import os; print(list(os.environ.items())[:3])",
];
PY_NESTED_DENY.push(...PY_CAPTURE_DENY);

const inlineDeny = [];
const inlineAllow = [];
const add = (arr, shell, cmds) => { for (const c of cmds) arr.push([shell, c]); };
for (const code of [...JS_DUMP, ...JS_SECRET, ...JS_NESTED_DENY]) { add(inlineDeny, 'bash', jsBash(code)); add(inlineDeny, 'powershell', jsPs(code)); }
for (const code of [...JS_ALLOW, ...JS_NESTED_ALLOW]) { add(inlineAllow, 'bash', jsBash(code)); add(inlineAllow, 'powershell', jsPs(code)); }
for (const code of JS_PRINT_DENY) { add(inlineDeny, 'bash', jsPrintBash(code)); add(inlineDeny, 'powershell', jsPrintPs(code)); }
for (const code of JS_PRINT_ALLOW) { add(inlineAllow, 'bash', jsPrintBash(code)); add(inlineAllow, 'powershell', jsPrintPs(code)); }
for (const code of [...PY_DUMP, ...PY_SECRET, ...PY_NESTED_DENY]) { add(inlineDeny, 'bash', pyBash(code)); add(inlineDeny, 'powershell', pyPs(code)); }
for (const code of [...PY_ALLOW, ...PY_NESTED_ALLOW]) { add(inlineAllow, 'bash', pyBash(code)); add(inlineAllow, 'powershell', pyPs(code)); }

// shells and PowerShell fed a script on stdin, -EncodedCommand, here-strings, streams, the unparseable fallback
add(inlineDeny, 'bash', [
  `bash <<'E'${NL}env${NL}E`,
  `bash -s <<'E'${NL}printenv GITHUB_TOKEN${NL}E`,
  `cat <<'E' | bash${NL}env | sort${NL}E`,
  `echo 'printenv' | sh`,
  `bash <<< 'env'`,
  `sh <<< "echo \\${D}GITHUB_TOKEN"`,
  `cat <<< hello${NL}env`,
  'env 2>/dev/null',
  'printenv 2>/dev/null | grep -i claude',
  `powershell -EncodedCommand ${enc('Get-ChildItem env:')}`,
  `pwsh -NoProfile -ec ${enc(`${D}env:GITHUB_TOKEN`)}`,
  `powershell -enc ${enc("node -e 'console.log(process.env)'")}`,
  `node -e 'console.log(process.env)' 2>/dev/null`,
  `node -e 'console.error(process.env)' > /tmp/out.txt`,
  `node -e 'console.error(process.env)' 2>&1 > /tmp/out.txt`,
  `node -p 'process.env' | grep -i claude`,
  `python3 -c 'import os; print(os.environ)' | sort`,
  // code that does not lex: only the clear forms
  `node -e 'console.log(process.env); "unterminated'`,
  `node -e 'console.log(process.env.GITHUB_TOKEN); (('`,
  `python3 -c 'import os; print(os.environ); ("'`,
  `python3 -c 'import os; print(os.environ["API_KEY"]) ]'`,
]);
add(inlineAllow, 'bash', [
  `bash <<'E'${NL}echo hi${NL}E`,
  `bash <<< 'env | cut -d= -f1'`,
  `echo 'compgen -e' | bash`,
  `cat <<'E' | bash${NL}git status${NL}E`,
  `cat <<< 'env'`,
  `grep -c TOKEN <<< 'printenv GITHUB_TOKEN'`,
  `powershell -EncodedCommand ${enc('Get-Process node')}`,
  `powershell -EncodedCommand ${enc('(Get-ChildItem env:).Name')}`,
  `pwsh -ec ${enc(`if (${D}env:GITHUB_TOKEN) { 'set' } else { 'unset' }`)}`,
  `node -e 'console.log(process.env)' > /tmp/out.txt`,
  `node -e 'console.error(process.env)' 2> /tmp/err.txt`,
  `node -e 'console.log(process.env)' &> /tmp/all.txt`,
  `node -e 'console.error(process.env)' > /tmp/out.txt 2>&1`,
  `node -e 'console.log(JSON.stringify(process.env))' | wc -c`,
  `python3 -c 'import os; print(os.environ)' | sha256sum`,
  `node -p 'process.env.GITHUB_TOKEN' | gh auth login --with-token`,
  `node -e 'console.log(process.env.HOME); (('`,
  `python3 -c 'print("hi"'`,
  'node scripts/print-env.mjs',
  'python3 tools/env_report.py',
  `node script.js <<'E'${NL}console.log(process.env)${NL}E`,
  `python3 -m json.tool <<< '{"a": 1}'`,
]);
add(inlineDeny, 'powershell', [
  `'Get-ChildItem env:' | powershell -`,
  `@'${NL}gci env:${NL}'@ | pwsh -Command -`,
  `@'${NL}${D}env:GITHUB_TOKEN${NL}'@ | powershell -NoProfile -`,
  `powershell -EncodedCommand ${enc('Get-ChildItem env:')}`,
  `pwsh -ec ${enc(`Write-Host ${D}env:API_KEY`)}`,
  `@"${NL}${D}(Get-ChildItem env: | Out-String)${NL}"@`,
  `Write-Host @"${NL}token: ${D}env:GITHUB_TOKEN${NL}"@`,
  // PowerShell 5.1 native-argument quoting: \" inside a single-quoted argument; "" inside a double-quoted one
  "node -e 'console.log(\\\"env\\\", process.env)'",
  "python -c 'import os; print(os.environ[\\\"GITHUB_TOKEN\\\"])'",
  'node -e "console.log(""env"", process.env)"',
  'python -c "import os; print(os.environ[""GITHUB_TOKEN""])"',
  // a string value prints itself
  `"token: ${D}env:GITHUB_TOKEN"`,
  `@"${NL}token: ${D}env:GITHUB_TOKEN${NL}"@`,
]);
// redirections are not arguments; a here-string into a program that prints it
add(inlineDeny, 'bash', [
  `echo ${D}GITHUB_TOKEN 2>/dev/null`,
  'printenv GITHUB_TOKEN 2> err.txt',
  'env 2> /dev/null',
  `cat <<< "${D}GITHUB_TOKEN"`,
  `base64 <<< "${D}{API_KEY}"`,
  `grep . <<< "${D}GITHUB_TOKEN"`,
]);
add(inlineAllow, 'bash', [
  'printenv HOME 2>/dev/null',
  `gh auth login --with-token <<< "${D}GITHUB_TOKEN"`,
  `grep -q x <<< "${D}GITHUB_TOKEN"`,
  `cat <<< "${D}{GITHUB_TOKEN:+set}"`,
  `cat <<< "${D}HOME"`,
  `cat <<< '${D}GITHUB_TOKEN'`,
]);
add(inlineAllow, 'powershell', [
  "'printenv'",
  "'printenv' | Set-Content notes.txt",
  '"gci env:"',
  `"home: ${D}env:USERPROFILE"`,
  `'token: ${D}env:GITHUB_TOKEN'`,
  `@'${NL}token: ${D}env:GITHUB_TOKEN${NL}'@`,
]);
add(inlineAllow, 'powershell', [
  `'Get-Process node' | powershell -`,
  `@'${NL}(Get-ChildItem env:).Name${NL}'@ | pwsh -Command -`,
  `${D}s = @'${NL}gci env:${NL}console.log(process.env)${NL}'@`,
  `@'${NL}printenv${NL}'@ | Set-Content notes.txt`,
  `powershell -EncodedCommand ${enc('Get-Process node')}`,
  'node -e "console.log(\\"home\\", process.env.HOME)"',
  `node -e 'console.log(process.env)' > out.txt`,
]);

// 0.31.28 review (A3): the reviewer's repro payloads, verbatim shapes
add(inlineDeny, 'bash', [
  "node -e 'require(\"child_process\").exec(\"env\", (e, o) => console.log(o))'",
  "node -e \"require('child_process').exec('env', (e, o) => console.log(o))\"",
  "node <<'EOF'" + NL + "const { exec } = require('child_process');" + NL + "exec('printenv', (e, o) => console.log(o));" + NL + 'EOF',
  "node -e 'console.log(require(\"child_process\").execSync(`env`).toString())'",
  "node <<'EOF'" + NL + "console.log(require('child_process').execSync(`printenv`).toString())" + NL + 'EOF',
]);

// 0.31.28 review (A2): bash expands a secret-named $NAME inside double-quoted code and an unquoted heredoc body
add(inlineDeny, 'bash', [
  'node -e "console.log(\'$FAKE_SVC_TOKEN\')"',
  'node -e "console.log(\'${DEMO_API_KEY}\')"',
  'node -p "\'$FAKE_SVC_TOKEN\'"',
  'python -c "print(\'$FAKE_SVC_TOKEN\')"',
  'python3 - <<EOF' + NL + "print('$FAKE_SVC_TOKEN')" + NL + 'EOF',
  'node <<EOF' + NL + 'console.log("${FAKE_SVC_TOKEN}")' + NL + 'EOF',
  'python3 <<EOF' + NL + 'import sys' + NL + "sys.stdout.write('$DEMO_API_KEY')" + NL + 'EOF',
  'cat <<EOF' + NL + '$FAKE_SVC_TOKEN' + NL + 'EOF',
  'cat <<-EOF' + NL + '\ttoken: ${DEMO_API_KEY:-none}' + NL + '\tEOF',
  'cat <<EOF | node' + NL + "console.log('$FAKE_SVC_TOKEN')" + NL + 'EOF',
  'echo "console.log(\'$FAKE_SVC_TOKEN\')" | node -',
  'node <<< "console.log(\'$FAKE_SVC_TOKEN\')"',
  'node -e "const t = \'$FAKE_SVC_TOKEN\'; console.log(t)"',
  'node -e "console.log(\\`tok=$FAKE_SVC_TOKEN \\${1}\\`)"',
  'node -e "console.log($FAKE_SVC_TOKEN)"',
  'python3 -c "print(f\'tok=$FAKE_SVC_TOKEN {1}\')"',
  'node -e \'console.log("\'$FAKE_SVC_TOKEN\'")\'',
]);
add(inlineAllow, 'bash', [
  'node -e \'console.log("$FAKE_SVC_TOKEN")\'',
  "node <<'EOF'" + NL + 'console.log("$FAKE_SVC_TOKEN")' + NL + 'EOF',
  'node <<"EOF"' + NL + 'console.log("$FAKE_SVC_TOKEN")' + NL + 'EOF',
  'node <<\\EOF' + NL + 'console.log("$FAKE_SVC_TOKEN")' + NL + 'EOF',
  "python3 - <<'EOF'" + NL + "print('$FAKE_SVC_TOKEN')" + NL + 'EOF',
  "cat <<'EOF'" + NL + '$FAKE_SVC_TOKEN' + NL + 'EOF',
  'cat <<EOF' + NL + '\\$FAKE_SVC_TOKEN' + NL + 'EOF',
  'cat <<EOF' + NL + '${FAKE_SVC_TOKEN:+set}' + NL + 'EOF',
  'cat <<EOF > out.txt' + NL + '$FAKE_SVC_TOKEN' + NL + 'EOF',
  'cat <<EOF | gh secret set FAKE_NAME' + NL + '$FAKE_SVC_TOKEN' + NL + 'EOF',
  'grep -c x <<EOF' + NL + '$FAKE_SVC_TOKEN' + NL + 'EOF',
  'cat <<EOF' + NL + '$HOME and $fake_svc_token' + NL + 'EOF',
  'node -e "console.log(\'$HOME\')"',
  'node -e "console.log(\'\\$FAKE_SVC_TOKEN\')"',
  'node -e "console.log(\'${FAKE_SVC_TOKEN:+set}\')"',
  'node -e "console.log(\'$FAKE_SVC_TOKEN\'.length)"',
  'node -e "fetch(\'https://example.test\', { headers: { Authorization: \'Bearer $FAKE_SVC_TOKEN\' } }).then((r) => console.log(r.status))"',
  'python3 -c "import urllib.request as u; u.urlopen(u.Request(\'https://example.test\', headers={\'Authorization\': \'Bearer $FAKE_SVC_TOKEN\'}))"',
  'node -e "console.log(\'$FAKE_SVC_TOKEN\')" > out.txt',
]);

for (const [shell, c] of inlineDeny) test(`inline program denied (${shell}): ${JSON.stringify(c).slice(0, 100)}`, () => assert.ok(hit(c, shell), c));
for (const [shell, c] of inlineAllow) test(`inline program allowed (${shell}): ${JSON.stringify(c).slice(0, 100)}`, () => assert.equal(hit(c, shell), null, c));

// 0.31.28 review (N1 / item 6): code over the 50,000-character inline cap gets the raw-text check for the clear forms
// instead of being skipped. Under the cap the full analysis also follows an alias; over it only the clear forms count.
const pyFill = (n) => Array.from({ length: n }, (_, i) => `x_${i} = ${i}  # filler line`).join(NL); // ~25 chars a line
const jsFill = (n) => Array.from({ length: n }, (_, i) => `const x_${i} = ${i}; // filler`).join(NL);
const pyHere = (body) => `python3 - <<'EOF'${NL}import os${NL}${body}${NL}EOF`;
const nodeHere = (body) => `node - <<'EOF'${NL}${body}${NL}EOF`;
const SMALL = 1500; // ~40,000 chars: under the cap
const BIG = 2600; // ~70,000 chars: over the cap
test('size cap: the filler sizes sit on both sides of the 50,000-char cap', () => {
  assert.ok(pyFill(SMALL).length > 30000 && pyFill(SMALL).length < 50000, String(pyFill(SMALL).length));
  assert.ok(pyFill(BIG).length > 60000, String(pyFill(BIG).length));
  assert.ok(jsFill(BIG).length > 60000, String(jsFill(BIG).length));
});
for (const [name, c] of [
  ['python heredoc, print(os.environ), under the cap', pyHere(`${pyFill(SMALL)}${NL}print(os.environ)`)],
  ['python heredoc, print(os.environ), over the cap', pyHere(`${pyFill(BIG)}${NL}print(os.environ)`)],
  ['python heredoc, secret read printed, over the cap', pyHere(`${pyFill(BIG)}${NL}print(os.environ['FAKE_SVC_TOKEN'])`)],
  ['python heredoc, alias printed, under the cap', pyHere(`${pyFill(SMALL)}${NL}e = os.environ${NL}print(e)`)],
  ['node heredoc, console.log(process.env), over the cap', nodeHere(`${jsFill(BIG)}${NL}console.log(process.env)`)],
  ['node heredoc, JSON.stringify(process.env), over the cap', nodeHere(`${jsFill(BIG)}${NL}console.log(JSON.stringify(process.env))`)],
  ['node -e, console.log(process.env), over the cap', `node -e '${jsFill(BIG).replace(/\n/g, ' ')} console.log(process.env)'`],
]) test(`size cap, denied: ${name}`, () => assert.ok(hit(c, 'bash'), name));
for (const [name, c] of [
  ['python heredoc, print(1), under the cap', pyHere(`${pyFill(SMALL)}${NL}print(1)`)],
  ['python heredoc, print(1), over the cap', pyHere(`${pyFill(BIG)}${NL}print(1)`)],
  ['python heredoc, sorted names, over the cap', pyHere(`${pyFill(BIG)}${NL}print(sorted(os.environ))`)],
  ['node heredoc, Object.keys, over the cap', nodeHere(`${jsFill(BIG)}${NL}console.log(Object.keys(process.env))`)],
  // the documented limit: over the cap an alias is not followed (only the clear forms are checked)
  ['python heredoc, alias printed, over the cap', pyHere(`${pyFill(BIG)}${NL}e = os.environ${NL}print(e)`)],
]) test(`size cap, allowed: ${name}`, () => assert.equal(hit(c, 'bash'), null, name));
test('size cap: the raw-text check stays fast near the 200,000-char command cap', () => {
  const c = pyHere(`${pyFill(6800)}${NL}print(os.environ)`);
  assert.ok(c.length > 190000 && c.length < 200000, String(c.length));
  const t0 = process.hrtime.bigint();
  assert.ok(hit(c, 'bash'));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, `${ms} ms`);
});

test('inline: the detail is the kind and the program word, never code', () => {
  assert.equal(envDumpHits("node -e 'console.log(process.env.GITHUB_TOKEN)'", 'bash').env, 'secret: node');
  assert.equal(envDumpHits("python3 -c 'import os; print(os.environ)'", 'bash').env, 'dump: python3');
});

test('inline: never throws on odd code', () => {
  for (const v of ["node -e '", 'node -e "((((', "python -c '\"\"\"", 'node -p', 'python -c', "node <<< '", `node - <<'E'${NL}`,
    `@'${NL}`, `@"${NL}${D}(`, 'powershell -EncodedCommand ####', 'powershell -EncodedCommand AAAA', "node -e '`${'", "python -c 'f\"{'"]) {
    assert.doesNotThrow(() => envDumpHits(v, 'bash'));
    assert.doesNotThrow(() => envDumpHits(v, 'powershell'));
  }
});

test('hook: inline node and python dumps are denied with the names-only text', () => {
  const r = hook('Bash', "node -e 'console.log(JSON.stringify(process.env))'");
  assert.equal(decisionOf(r.json), 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /Object\.keys\(process\.env\)/);
  assert.equal(decisionOf(hook('Bash', `python3 - <<'E'${NL}import os${NL}print(os.environ['GITHUB_TOKEN'])${NL}E`).json), 'deny');
  assert.equal(decisionOf(hook('PowerShell', `@'${NL}console.log(process.env)${NL}'@ | node -`).json), 'deny');
});
test('hook: inline names-only, presence and plain reads pass', () => {
  assert.notEqual(decisionOf(hook('Bash', "node -e 'console.log(Object.keys(process.env))'").json), 'deny');
  assert.notEqual(decisionOf(hook('Bash', "python3 -c 'import os; print(bool(os.getenv(\"GITHUB_TOKEN\")))'").json), 'deny');
  assert.notEqual(decisionOf(hook('PowerShell', "node -e 'console.log(process.env.PATH)'").json), 'deny');
});
