import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd();
const reduced = args.includes('--no-derived');
let hit = false;
const notes = join(root, 'NOTES.md');
if (existsSync(notes)) {
  const text = readFileSync(notes, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('private path: C:')) {
      console.log(`  NOTES.md:${i + 1}  [private-path:windows-profile]  REDACTED  ::  ${lines[i]}`);
      hit = true;
    }
  }
}
if (!reduced) {
  console.log('  NOTES.md:1  [derived-project-name]  REDACTED  ::  derived hit (only when not reduced)');
  hit = true;
}
process.exit(hit ? 1 : 0);
