// Reader shapes injected into scripts/recommend.mjs to prove the reader check
// goes red on each: the adversarial review's full set (the old
// comment-stripping regex missed multi-line, for-of and arrow-parameter
// destructuring, computed keys and Reflect.get, and caught several others
// only by luck), plus a spread copy. Every one must be caught.
export const ANCHOR = 'const argv = process.argv.slice(2);';
const T = 'modelTiers().taskTypes.explore';

export const MUTANTS = {
  'destructure multi-line': `const {\n  override: ovML,\n} = ${T};\nvoid ovML;`,
  'destructure in for-of': `for (const [, { override: ovF }] of Object.entries(modelTiers().taskTypes)) void ovF;`,
  'destructure in arrow param': `const pick = ({ override }) => override; void pick(${T});`,
  'computed key variable': `const KEY = 'override'; void ${T}[KEY];`,
  'string concat key': `void ${T}['over' + 'ride'];`,
  'Reflect.get': `void Reflect.get(${T}, 'override');`,
  'Object.entries find': `void Object.entries(${T}).find(([k]) => k === 'override');`,
  'hidden after " //" in a string': `const sep = ' //'; void ${T}.override;`,
  'line starting with *': `const zz = 2\n  * (${T}.override ? 1 : 1);`,
  'JSON round-trip': `void JSON.parse(JSON.stringify(${T})).override;`,
  'spread copy': `const copy = { ...${T} }; void copy;`,
  'dot': `void ${T}.override;`,
  'optional chain': `void ${T}?.override;`,
  'bracket single-quote': `void ${T}['override'];`,
  'optional bracket': `void ${T}?.["override"];`,
  'destructure one line': `const { override } = ${T}; void override;`,
  'destructure rename one line': `const { weight: _w, override: ov1 } = ${T}; void ov1;`,
};
