// node:test reporter for ci-local.mjs's human-readable output: node's own
// `spec` reporter, with one change — a `todo` test is never listed as a
// failure.
//
// A todo test that throws is reported by node as a test:fail event carrying
// `todo`, and `spec` collects every test:fail into its closing "failing
// tests:" block. A todo is deliberately held work (its failure is expected
// and does not fail the run), so listing it there made a green run read as a
// red one. Here a failing todo's error is marked with the failureType `spec`
// itself uses for "a parent whose subtests failed" ('subtestsFailed'), the one
// kind of test:fail it prints in place (with its ⚠ todo marker and "# <todo
// reason>") but never repeats in the failing block. Relabelling the event as
// a test:pass would also keep it out of the block, but prints a ✔ — a lie
// about a test that threw. The run's own counts (ℹ pass / fail / todo /
// skipped) come from node's summary and are unaffected. A closing "todo tests
// (not failures)" block names each one so it stays visible.
// scripts/tests/ci-local-reporting.test.mjs pins this: if a future node
// renames that failureType, the test fails rather than the wording silently
// regressing.

import { spec as Spec } from 'node:test/reporters';
import { Readable } from 'node:stream';
import { relative } from 'node:path';

const SUBTESTS_FAILED = 'subtestsFailed';
const isTodo =(data) => data && data.todo !== undefined && data.todo !== false;

export default async function* ciLocalHumanReporter(source) {
  const todos = [];
  async function* relabel() {
    for await (const event of source) {
      if (event.type === 'test:fail' && isTodo(event.data)) {
        todos.push(event.data);
        const details = event.data.details || {};
        const error = details.error || new Error('todo test failed');
        yield {
          ...event,
          data: { ...event.data, details: { ...details, error: Object.assign(Object.create(Object.getPrototypeOf(error)), error, { failureType: SUBTESTS_FAILED, message: error.message, stack: error.stack }) } },
        };
      } else {
        if (event.type === 'test:pass' && isTodo(event.data)) todos.push(event.data);
        yield event;
      }
    }
  }
  const spec = new Spec();
  Readable.from(relabel(), { objectMode: true }).pipe(spec);
  for await (const chunk of spec) yield chunk;
  if (todos.length) {
    const lines = ['', `ℹ todo tests (${todos.length}, not failures — held on purpose):`];
    for (const t of todos) {
      const where = t.file ? `${relative(process.cwd(), t.file)}:${t.line}` : '';
      const why = typeof t.todo === 'string' && t.todo ? ` # ${t.todo}` : '';
      lines.push(`  ${where}  ${t.name}${why}`);
    }
    yield `${lines.join('\n')}\n`;
  }
}
