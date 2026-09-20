// SessionStart / UserPromptSubmit — inject the operator's standing rules.
//
// One file, two events, selected by ARGV (`--event session-start` /
// `--event user-prompt`), never sniffed from the payload — the two events'
// payloads barely overlap (session-start has no prompt text at all), and an
// event inferred from payload shape cannot be driven deterministically from
// a test. tests/helpers.mjs's runHook() already supports passing argv for
// exactly this reason.
//
// Silence is the default state (see hooks/lib/rules.mjs's own banner): a
// turn with nothing to say produces EMPTY STDOUT, not an empty JSON envelope
// and never a systemMessage. A rule firing is not news the operator needs a
// line of chrome about on every single prompt — that chrome is exactly the
// token tax this whole feature exists to cut.
//
// user-prompt evaluates TWO scopes — 'always' (unconditional; the reason
// gates exist, see delegate-reminder) and 'user-prompt' (regex-gated) — and
// the results are re-sorted back into the ORIGINAL FILE ORDER (built-ins in
// shipped order, then user rules in file order) rather than left in
// call-then-call order, so an 'always' rule checked second in this file
// never jumps ahead of a 'user-prompt' rule that appears earlier in
// standing-rules.json.
//
// The rendered block is hard-capped at 4000 chars regardless of
// standing_rules_max_chars: the harness silently truncates additionalContext
// above 10000 by writing it to a file and substituting a preview (verified
// behaviour), and there is no reason for this feature — built to SAVE
// tokens — to ever approach that.

import { readStdin, opt, passthrough } from './lib/context.mjs';
import { matchRules, renderRules, readRules } from './lib/rules.mjs';

const HARD_CAP = 4000;

function emit(hookEventName, text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: text.slice(0, HARD_CAP) },
  }));
  process.exit(0);
}

try {
  const p = readStdin();
  if (!opt('standing_rules', true)) passthrough();

  const argv = process.argv.slice(2);
  const eventIdx = argv.indexOf('--event');
  const event = eventIdx >= 0 ? argv[eventIdx + 1] : '';
  const sessionId = p.session_id;

  if (event === 'session-start') {
    const matched = matchRules({ scope: 'session-start', sessionId });
    const text = renderRules(matched);
    if (!text) passthrough();
    emit('SessionStart', text);
  } else if (event === 'user-prompt') {
    const prompt = p.prompt ?? p.user_input ?? '';
    const always = matchRules({ scope: 'always', sessionId });
    const prompted = matchRules({ scope: 'user-prompt', text: prompt, sessionId });

    const { rules: all } = readRules();
    const order = new Map(all.map((r, i) => [r.id, i]));
    const matched = [...always, ...prompted].sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );

    const text = renderRules(matched);
    if (!text) passthrough();
    emit('UserPromptSubmit', text);
  } else {
    passthrough(); // unknown/missing --event: never guess which payload shape this is
  }
} catch {
  passthrough(); // never break a session
}
