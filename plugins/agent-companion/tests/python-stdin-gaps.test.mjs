// python_stdin_guard, 0.31.21: the wrapped forms of "python reads its program from stdin", and the denials log.
// Rule: a wrapped form is judged exactly as its plain equivalent is. The plain cases live in
// python-stdin-guard.test.mjs; this file holds one table per wrapper form plus the denial records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import './helpers.mjs';
import { makeFixture, runHook, readJsonl, decisionOf } from './helpers.mjs';
import { pythonStdinCheck, pythonStdinGuard, PY_MSG } from '../hooks/lib/python-stdin.mjs';

const NL = '\n';
const P = 'python3';
const check = (cmd, extra = {}) => pythonStdinCheck(cmd, { platform: 'win32', ...extra });

// form -> { deny: [...], allow: [...] }
const FORMS = {
  loop: {
    deny: [
      `for f in a b; do ${P} -; done`,
      `for f in a b; do ${P} - ; done`,
      `while true; do ${P} -; done`,
      `until false; do ${P} -; break; done`,
      `for f in a; do ${P} - < /dev/null; done`,
      `for f in a; do ${P} -; done < /dev/null`,
      `for f in a; do for g in b; do ${P} -; done; done`,
      `for f in a; do echo "$f"; ${P}; done`,
      `if true; then for f in a; do ${P} -; done; fi`,
      `for f in a; do ${P} -; done${NL}echo after`,
    ],
    allow: [
      `for f in a b; do ${P} -c 'print(1)'; done`,
      `for f in a b; do ${P} script.py "$f"; done`,
      `for f in a; do ${P} - < s.py; done`,
      `for f in a; do echo 'print(1)' | ${P} -; done`,
      `for f in a; do ${P} - <<'E'${NL}print(1)${NL}E${NL}done`,
      `echo 'print(1)' | for f in a; do ${P} -; done`,
      `cat s.py | while true; do ${P} -; break; done`,
      `for f in a; do ${P} -; done < s.py`,
      `for f in a; do ${P} -; done <<< 'print(1)'`,
      `while read l; do ${P} -; done < list.txt`,
      `for f in a; do ${P} -m json.tool < /dev/null; done`,
      `for f in a; do ${P} -c 1; done < /dev/null`,
    ],
  },
  function: {
    deny: [
      `f() { ${P} -; }; f`,
      `f() { ${P} -; }${NL}f`,
      `f() { ${P} -; }; f < /dev/null`,
      `function f { ${P} -; }; f`,
      `function f() { ${P} -; }; f`,
      `f() { ${P} -; }; echo x | f; f`,
      `f() { ${P} -; }; time f`,
      `f() { ${P} -; }; x=$(f)`,
      `f() { for i in a; do ${P} -; done; }; f`,
      `f() { ${P} -; }; g() { f; }; g`,
    ],
    allow: [
      `f() { ${P} -c 1; }; f`,
      `f() { ${P} -; }`,
      `f() { ${P} -; }; echo x | f`,
      `f() { ${P} -; }; f < prog.py`,
      `f() { ${P} -; } < prog.py; f`,
      `function f { ${P} -; }`,
      `function f { ${P} -; }; echo x | f`,
      `f() { ${P} script.py; }; f`,
      `f() { ${P} -; }; g() { f; }; echo x | g`,
      `f() { ${P} -; f; }; echo x | f`,
      `f() { ${P} -; }; g; echo done`,
    ],
  },
  timeout: {
    deny: [
      `timeout 5 ${P} -`,
      `timeout 5s ${P} -`,
      `timeout -k 2 5 ${P} -`,
      `timeout --signal=KILL 5 ${P} -`,
      `timeout --kill-after 2 5 ${P} -`,
      `timeout --foreground 5 ${P} -`,
      `timeout 5 ${P} - < /dev/null`,
      `timeout 10 ${P}`,
      `timeout 5 ${P} -u -`,
      `echo hi; timeout 5 ${P} -`,
    ],
    allow: [
      `timeout 30 ${P} script.py`,
      `timeout 30 ${P} -c 'print(1)'`,
      `timeout 30 ${P} -m pip --version`,
      `timeout 5 ${P} - < script.py`,
      `echo 'print(1)' | timeout 5 ${P} -`,
      `timeout 5 ${P} - <<'E'${NL}print(1)${NL}E`,
      `timeout -k 2 5 ${P} script.py`,
      `timeout 5 ${P} --version`,
      `timeout 5`,
      `timeout`,
    ],
  },
  env: {
    deny: [
      `env -u FOO ${P} -`,
      `env -u FOO -u BAR ${P} -`,
      `env -uFOO ${P} -`,
      `env --unset=FOO ${P} -`,
      `env --unset FOO ${P} -`,
      `env -i FOO=1 ${P} -`,
      `env -u FOO BAR=1 ${P} -`,
      `env -C /tmp ${P} -`,
      `env -u FOO timeout 5 ${P} -`,
      `timeout 5 env -u FOO ${P} -`,
      `env -u FOO ${P} - < /dev/null`,
      `env -- ${P} -`,
    ],
    allow: [
      `env -u FOO ${P} script.py`,
      `env -u FOO ${P} -c 'print(1)'`,
      `env -u FOO -u BAR FOO=1 ${P} -c 1`,
      `echo 'print(1)' | env -u FOO ${P} -`,
      `env -u FOO ${P} - < s.py`,
      `env -u FOO ${P} - <<'E'${NL}print(1)${NL}E`,
      `env -u ${P}`,
      `env -u FOO`,
      `env FOO=1 ${P} script.py`,
    ],
  },
  substitution: {
    deny: [
      `x="$(${P} -)"`,
      `echo "$(${P} -)"`,
      `"$(${P} -)"`,
      `echo "a $(${P} -) b"`,
      `echo "\`${P} -\`"`,
      `$(${P} -)`,
      `$(python -)`,
      `echo $(${P} -)`,
      `echo "$(echo hi; ${P} -)"`,
      `echo "$(echo "$(${P} -)")"`,
      `for i in a; do echo "$(${P} -)"; done`,
      `echo "$(timeout 5 ${P} -)"`,
      `echo "$(${P} - < /dev/null)"`,
      `echo "$(env -u X ${P} -)" | cat`,
      `x="$(${P} -)" && echo "$x"`,
      `echo "$(${P} -)"${NL}echo done`,
    ],
    allow: [
      `x="$(${P} -c 'print(1)')"`,
      `echo "$(${P} script.py)"`,
      `echo "$(echo 'print(1)' | ${P} -)"`,
      `echo "$(${P} - < s.py)"`,
      `echo "$(${P} - <<'E'${NL}print(1)${NL}E${NL})"`,
      `echo "$(echo '${P} -')"`,
      `echo "$(date)" | ${P} -`,
      `echo "a (b) c $(echo hi) d"`,
      `git commit -m "fix $(echo ${P} - ) x"`,
      `echo "$(date)"`,
      `echo "$(`,
      `echo "$(${P} -c 1`,
    ],
  },
  combined: {
    deny: [
      `for f in a; do timeout 5 env -u X ${P} -; done`,
      `f() { timeout 5 ${P} -; }; f`,
      `for f in a; do x="$(timeout 5 ${P} -)"; done`,
    ],
    allow: [
      `for f in a; do timeout 5 env -u X ${P} script.py; done`,
      `f() { timeout 5 ${P} -; }; echo x | f`,
      `for f in a; do x="$(timeout 5 ${P} -c 1)"; done`,
    ],
  },
};

for (const [form, { deny, allow }] of Object.entries(FORMS)) {
  for (const c of deny) {
    test(`gap form ${form}: denies ${JSON.stringify(c).slice(0, 90)}`, () => {
      const r = check(c);
      assert.ok(r, 'expected a deny');
      assert.equal(r.mode, 'deny');
      assert.equal(r.message, PY_MSG);
    });
  }
  for (const c of allow) {
    test(`gap form ${form}: allows ${JSON.stringify(c).slice(0, 90)}`, () => {
      assert.equal(check(c), null);
    });
  }
}

// A wrapped form has to be judged like its plain equivalent: same verdict for every stdin shape.
test('gap forms: wrapped verdict equals the plain verdict across stdin shapes', () => {
  const tails = [' -', ' - < /dev/null', ' - < s.py', " -c 'x'", ' s.py', '', ` - <<'E'${NL}E`, ` - <<'E'${NL}print(1)${NL}E`];
  const wraps = [
    (s) => `for f in a; do ${s}; done`,
    (s) => `timeout 5 ${s}`,
    (s) => `env -u X ${s}`,
    (s) => `echo "$(${s})"`,
    (s) => `$(${s})`,
  ];
  for (const t of tails) {
    // Heredoc forms need a newline before the closer, so the wrapper must not add text after the body.
    if (t.includes(NL)) continue;
    const plain = check(P + t) ? 'deny' : 'allow';
    for (const w of wraps) {
      const wrapped = w(P + t);
      assert.equal(check(wrapped) ? 'deny' : 'allow', plain, wrapped);
    }
  }
});

// Linear time on shapes aimed at the new paths: 300K characters each.
const N = 300000;
const fill = (head, unit) => (head + unit.repeat(Math.ceil((N - head.length) / unit.length))).slice(0, N);
const BIG = [
  ['dq substitutions in sequence', `"$(${P} -c 1)" `.repeat(Math.floor(N / 20)), 'allow'],
  ['dq substitutions nested', fill('', '"$('), 'allow'],
  ['dq backticks', fill('', '"`'), 'allow'],
  ['dq substitution, python at the end', `"$(${P} -c 1)" `.repeat(Math.floor(N / 20)) + `"$(${P} -)"`, 'deny'],
  ['loop headers', fill('', 'for f in a; do '), 'allow'],
  ['loops then python', fill('', 'for f in a; do ') + `${P} -`, 'deny'],
  ['function definitions', fill('', 'f() { '), 'allow'],
  ['function calls in a body', 'f() { ' + fill('', 'f; ') + `${P} -; }; f`, 'deny'],
  ['recursive function, many calls', `f() { ${P} -; }; ` + fill('', 'f; '), 'deny'],
  ['env options', fill(`env `, '-u X '), 'allow'],
  ['timeout options', fill('timeout ', '-k 1 '), 'allow'],
  ['then keywords', fill('', 'then '), 'allow'],
];
for (const [name, cmd, want] of BIG) {
  test(`300K shape: ${name}`, () => {
    const t0 = Date.now();
    const r = check(cmd);
    const ms = Date.now() - t0;
    assert.equal(r ? 'deny' : 'allow', want);
    assert.ok(ms < 1000, `took ${ms} ms`);
  });
}

test('wrapped forms are inert on non-win32 platforms', () => {
  for (const platform of ['linux', 'darwin']) {
    for (const f of Object.values(FORMS)) {
      for (const c of f.deny) assert.equal(pythonStdinCheck(c, { platform }), null, platform + ' ' + c);
    }
  }
});

test('fail-open: a malformed wrapped form allows', () => {
  for (const c of ['for', 'do', 'f() {', 'env -u', 'timeout -k', '"$(', '"`', 'function', 'function f']) {
    assert.doesNotThrow(() => check(c), c);
  }
  assert.equal(check('env -u'), null);
  assert.equal(check('timeout -k'), null);
});

// --- denials log -------------------------------------------------------------------------------

function withFixture(fn) {
  const fx = makeFixture();
  try { return fn(fx, () => readJsonl(join(fx.stateDir, 'telemetry', 'denials.jsonl'))); } finally { fx.cleanup(); }
}
const payload = (command, extra = {}) => ({ session_id: 's-pydeny', tool_name: 'Bash', tool_input: { command }, ...extra });
const guard = (command, opts = {}, extra = {}) => pythonStdinGuard(payload(command, extra), { platform: 'win32', ...opts });

test('denials log: one record per deny, none per allow', () => {
  withFixture((fx, rows) => {
    assert.equal(guard(`${P} -c 'print(1)'`), null);
    assert.equal(guard(`${P} script.py`), null);
    assert.equal(guard(`echo hi`), null);
    assert.equal(guard(`echo 'print(1)' | ${P} -`), null);
    assert.deepEqual(rows(), []);
    const r1 = guard(`${P} -`);
    assert.ok(r1 && r1.mode === 'deny');
    assert.equal(rows().length, 1);
    const r2 = guard(`for f in a; do ${P} -; done`);
    assert.ok(r2 && r2.mode === 'deny');
    assert.equal(rows().length, 2);
    assert.equal(guard(`${P} -c 1`), null);
    assert.equal(rows().length, 2);
  });
});

test('denials log: record shape matches the other guards', () => {
  withFixture((fx, rows) => {
    const cmd = `${P} - < /dev/null`;
    guard(cmd, {}, { agent_type: 'general-purpose' });
    const [d] = rows();
    assert.equal(d.guard, 'python-stdin');
    assert.equal(d.outcome, 'deny');
    assert.equal(d.tool_name, 'Bash');
    assert.equal(d.session_id, 's-pydeny');
    assert.equal(d.agent_type, 'general-purpose');
    assert.equal(typeof d.v, 'number');
    assert.ok(!Number.isNaN(Date.parse(d.at)));
    assert.ok(d.detail.includes(cmd), d.detail);
  });
});

test('denials log: command text is truncated to 300 characters', () => {
  withFixture((fx, rows) => {
    guard(`${P} - # ${'x'.repeat(2000)}`);
    const [d] = rows();
    assert.ok(d.detail.length <= 300, String(d.detail.length));
    assert.ok(d.detail.startsWith('python reading its program from stdin'));
  });
});

test('denials log: warn mode records outcome warn, off and non-win32 record nothing', () => {
  withFixture((fx, rows) => {
    const w = guard(`${P} -`, { mode: 'warn' });
    assert.equal(w.mode, 'warn');
    assert.deepEqual(rows().map((d) => d.outcome), ['warn']);
    assert.equal(guard(`${P} -`, { mode: 'off' }), null);
    assert.equal(guard(`${P} -`, { platform: 'linux' }), null);
    assert.equal(rows().length, 1);
  });
});

test('denials log: an acked call is an allow and writes nothing', () => {
  withFixture((fx, rows) => {
    assert.equal(guard(`${P} - < /dev/null # guard-ack: python-stdin`), null);
    assert.deepEqual(rows(), []);
  });
});

// Hook level (the real platform decides, so win32 only).
const winOnly = { skip: process.platform !== 'win32' };
test('hook: one denials record per deny, none per allow', winOnly, () => {
  withFixture((fx, rows) => {
    const run = (command, env = {}) => runHook('hooks/poll-guard.mjs', payload(command), { env });
    assert.equal(decisionOf(run(`${P} -c 'print(1)'`).json), null);
    assert.equal(decisionOf(run(`timeout 30 ${P} script.py`).json), null);
    assert.deepEqual(rows(), []);
    assert.equal(decisionOf(run(`timeout 5 ${P} -`).json), 'deny');
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].guard, 'python-stdin');
    assert.equal(decisionOf(run(`${P} - < /dev/null # guard-ack: python-stdin`).json), null);
    assert.equal(decisionOf(run(`${P} -`, { CLAUDE_PLUGIN_OPTION_PYTHON_STDIN_GUARD: 'off' }).json), null);
    assert.equal(rows().length, 1);
  });
});
