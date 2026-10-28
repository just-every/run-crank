// A source archive supplies one caller-identified revision, never Git history.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {hash, safe} from './files.mjs';

const limit = 64 * 1024 * 1024;
const objectId = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export function archiveReader(directory, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('A Base archive requires its immutable full 40-character Base commit in --ref');
  if (!fs.lstatSync(directory).isDirectory()) throw Error('Base archive must be a plain directory without .git');
  const root = fs.realpathSync(directory), tree = new Map(), objects = new Map();
  function bytes(name) {
    const filename = path.join(root, name), stat = fs.lstatSync(filename);
    if (!stat.isFile()) throw Error(`Base archive source is not a regular file: ${name}`);
    if (stat.size > limit) throw Error('Base archive source output exceeds the 64 MiB acquisition limit');
    return fs.readFileSync(filename);
  }
  function walk(prefix = '') {
    for (const name of fs.readdirSync(path.join(root, prefix)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      if (name.toLowerCase() === '.git') throw Error('Base archive must be a plain directory without .git');
      const relative = safe(prefix ? `${prefix}/${name}` : name), stat = fs.lstatSync(path.join(root, relative));
      if (stat.isDirectory()) walk(relative);
      else if (stat.isFile()) {
        const object = objectId(bytes(relative)), mode = stat.mode & 0o100 ? '100755' : '100644';
        tree.set(relative, {object, mode});
        if (!objects.has(object)) objects.set(object, relative);
      } else throw Error(`Unsupported Base archive entry: ${relative}; supply regular files and directories only`);
    }
  }
  walk();
  const orderedTree = new Map([...tree].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  const history = () => { throw Error('Base archive has no Git history. Repeat with --base <checkout> containing the recorded and target commits; no files were refreshed.'); };
  return {
    historyAvailable: false,
    objectId,
    tree(pin) { return pin === revision ? orderedTree : history(); },
    blobs(ids) {
      const result = new Map(), unique = [...new Set(ids)];
      for (let offset = 0; offset < unique.length; offset += 100) {
        let size = 0;
        for (const object of unique.slice(offset, offset + 100)) {
          const name = objects.get(object);
          if (!name) throw Error(`Base archive object ${object} is not available`);
          const data = bytes(name);
          size += data.length;
          if (size > limit) throw Error('Base archive source output exceeds the 64 MiB acquisition limit');
          if (objectId(data) !== object) throw Error(`Base archive changed while reading ${name}; retry with an unchanged archive`);
          result.set(object, data);
        }
      }
      return result;
    },
    digests(ids) { return new Map([...this.blobs(ids)].map(([object, data]) => [object, hash(data)])); },
    contains: history,
    history,
  };
}
