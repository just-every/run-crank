import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from './files.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const quote = value => /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export const snapshot = file => ({sha256: hash(file.read()), mode: file.executable ? '100755' : '100644'});

export function acknowledgementCommand(root, name, recordPath) {
  const relative = path.relative(root, cli);
  return ['node', relative.startsWith('..') ? cli : relative, 'adapt-base', name,
    ...(recordPath === 'base-copies.json' ? [] : ['--record', recordPath])].map(quote).join(' ');
}

// Keep the upstream baseline separate from the local bytes the owner accepted.
// Legacy declarations remain readable, but cannot silently acknowledge new bytes.
export function acknowledgementDrift(root, copy, name, file, recordPath) {
  const detail = {path: name, copy: copy.path, acknowledge: acknowledgementCommand(root, name, recordPath)};
  const expected = copy.acknowledged?.[name];
  if (!expected) return [{kind: 'adaptation-unacknowledged', ...detail}];
  const actual = snapshot(file);
  const drift = [];
  if (actual.sha256 !== expected.sha256) drift.push({kind: 'adaptation-modified', ...detail, expected: expected.sha256, actual: actual.sha256});
  if (actual.mode !== expected.mode) drift.push({kind: 'adaptation-mode', ...detail, expected: expected.mode, actual: actual.mode});
  return drift;
}
