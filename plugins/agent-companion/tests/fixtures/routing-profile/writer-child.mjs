// A concurrent writer for tests/routing-profile-journal.test.mjs: performs
// `count` set operations on the given types, round-robin, through the one
// validated writer. Prints one JSON line per applied revision.
// argv: <count> <type[:model]>... — efforts cycle through a fixed list.
import { setRow } from '../../../scripts/lib/routing-profile-store.mjs';

const [count, ...specs] = process.argv.slice(2);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const out = [];
for (let i = 0; i < Number(count); i += 1) {
  const [type, model = 'sonnet'] = specs[i % specs.length].split(':');
  const effort = EFFORTS[i % EFFORTS.length];
  const res = setRow(type, { model, effort, because: `writer ${process.pid} op ${i}`, by: `test-writer-${process.pid}` });
  out.push({ type, model, effort, revision: res.revision });
}
process.stdout.write(JSON.stringify(out) + '\n');
