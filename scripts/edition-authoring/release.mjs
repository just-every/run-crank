import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fresh, git, hash, json} from './files.mjs';

export function release(root, destination, check) {
  const output = fresh(destination, root);
  const receiptPath = fresh(output + '.release.json', root);
  if (git(root, 'status', '--porcelain', '--untracked-files=all')) throw Error('Release requires a clean committed edition');
  const lock = check();
  const comparisons = [...lock.components, ...(lock.parent ? [{baseline: lock.parent}] : [])];
  const pending = comparisons.filter(c => c.baseline).map(c => c.baseline);
  const checked = new Set();
  while (pending.length) {
    const baseline = pending.pop();
    if (checked.has(baseline.key)) continue;
    checked.add(baseline.key);
    const filename = '.edition/sources/' + baseline.key + '.json';
    if (!git(root, 'ls-files', '--', filename)) throw Error('Comparison source snapshot must be tracked');
    const archive = JSON.parse(fs.readFileSync(path.join(root, filename)));
    pending.push(...(archive.dependencies || []));
  }
  const commit = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  execFileSync('git', ['clone', '--no-hardlinks', '--', root, output], {stdio: 'pipe'});
  git(output, 'remote', 'remove', 'origin');
  const receipt = {
    schemaVersion: 1, edition: lock.edition, source: {commit, tree},
    lockSha256: hash(fs.readFileSync(path.join(root, 'sources.lock.json'))), toolchain: lock.toolchain,
    verification: 'source integrity only; no product build or deployment asserted',
  };
  // Outside the author tree: publication preserves the exact authoritative commit.
  fs.writeFileSync(receiptPath, json(receipt), {flag: 'wx'});
  return {output, receiptPath, ...receipt};
}

export function verifyReceipt(root, filename, check) {
  const receipt = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const lock = check();
  if (receipt.schemaVersion !== 1 || receipt.edition !== lock.edition ||
      receipt.source?.commit !== git(root, 'rev-parse', 'HEAD') ||
      receipt.source?.tree !== git(root, 'rev-parse', 'HEAD^{tree}') ||
      receipt.lockSha256 !== hash(fs.readFileSync(path.join(root, 'sources.lock.json'))) ||
      json(receipt.toolchain) !== json(lock.toolchain) || git(root, 'status', '--porcelain', '--untracked-files=all')) {
    throw Error('Receipt does not identify this clean source checkout');
  }
  return {ok: true, ...receipt, verification: 'source integrity only; receipt is not publisher authentication or product acceptance'};
}
