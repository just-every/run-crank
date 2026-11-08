import path from 'node:path';

const inside = (name, prefix) => name === prefix || name.startsWith(prefix + '/');
const common = (left, right) => {
  const a = left.split('/'), b = right.split('/');
  let length = 0;
  while (length < a.length && a[length] === b[length]) length++;
  return a.slice(0, length).join('/');
};

// Two disjoint recorded subtrees with the same relative placement establish
// their shared namespace. One copy alone cannot authorize unrelated siblings,
// and agreement never extends to the repository root or outside the edition.
export function sharedNamespaces(mappings) {
  // File selections witness their own siblings, not a parent above that
  // directory. Only directory copies establish a shared subtree selection.
  mappings = mappings.filter(({directory}) => directory);
  const result = new Map();
  for (let i = 0; i < mappings.length; i++) for (const b of mappings.slice(i + 1)) {
    const a = mappings[i];
    if (inside(a.from, b.from) || inside(b.from, a.from)) continue;
    if (path.posix.relative(a.from, b.from) !== path.posix.relative(a.to, b.to)) continue;
    const from = common(a.from, b.from), to = common(a.to, b.to);
    if (!from || from === '.' || !to || to === '.' || to.startsWith('../')) continue;
    result.set(JSON.stringify([from, to]), {from, to});
  }
  return [...result.values()];
}
