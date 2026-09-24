// node:test reporter for ci-local.mjs's machine-readable results: one JSON
// object per line, written to the --test-reporter-destination file ci-local
// passes. ci-local reads it to count pass / fail / todo / skipped exactly
// and to know WHICH test files failed, so it can re-run each of those once
// on its own (see runTestSuite() in ci-local.mjs).
//
//   {"type":"fail","file":"<abs path>","name":"..."}   a real failure (never a todo)
//   {"type":"summary","file":null|"<abs>","counts":{...}}  node's own counts

const isTodo = (data) => data && data.todo !== undefined && data.todo !== false;

export default async function* ciLocalResultsReporter(source) {
  for await (const { type, data } of source) {
    if (type === 'test:fail' && !isTodo(data)) {
      yield `${JSON.stringify({ type: 'fail', file: data.file || null, name: data.name })}\n`;
    } else if (type === 'test:summary') {
      yield `${JSON.stringify({ type: 'summary', file: data.file || null, counts: data.counts })}\n`;
    }
  }
}
