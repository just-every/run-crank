// Directory archives supply one snapshot. GitHub can also prove ancestry and
// supply older immutable trees without requiring a local Git object store.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {hash, safe} from './files.mjs';

const limit = 64 * 1024 * 1024;
const objectId = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const commit = /^[a-f0-9]{40}$/;

export function apiReader(repository, revision) {
  if (!commit.test(revision)) throw Error('Base API requires an immutable full 40-character commit');
  const request = endpoint => {
    try {
      return JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${endpoint}`], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: limit,
      }));
    } catch (error) {
      // Keep provider failures explicit without echoing arbitrary gh stderr,
      // authentication diagnostics or credential-bearing transport URLs.
      const status = /\bHTTP (\d{3})\b/.exec(error.stderr?.toString() ?? '')?.[1];
      throw Error(`Cannot read Base ${revision} from the GitHub API${status ? ` (HTTP ${status})` : ''} (${endpoint}); no files were refreshed or copy record changed.`);
    }
  };
  const trees = new Map(), objects = new Map(), ancestry = new Map();
  return {
    // Workflow-template discovery remains snapshot-only; no path history is
    // invented from the API tree or the archive's version.
    historyAvailable: false,
    objectId,
    tree(pin) {
      if (!commit.test(pin)) throw Error('Base API requires an immutable full 40-character commit');
      if (!trees.has(pin)) {
        const pinned = request(`git/commits/${pin}`);
        if (pinned.sha !== pin || !commit.test(pinned.tree?.sha)) throw Error('Base API did not resolve the immutable commit');
        const entries = new Map();
        const walk = (identity, prefix = '', recursive = true) => {
          const tree = request(`git/trees/${identity}${recursive ? '?recursive=1' : ''}`);
          if (recursive && tree.sha === identity && tree.truncated === true) return walk(identity, prefix, false);
          if (tree.sha !== identity || tree.truncated !== false || !Array.isArray(tree.tree)) throw Error('Incomplete Base API tree');
          for (const entry of tree.tree) {
            safe(entry.path);
            if ((!recursive && entry.path.includes('/')) || !commit.test(entry.sha)) throw Error('Invalid Base API tree entry');
            const name = prefix + entry.path;
            if (!recursive && entry.type === 'tree' && entry.mode === '040000') walk(entry.sha, name + '/');
            else if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)) entries.set(name, {object: entry.sha, mode: entry.mode});
          }
        };
        walk(pinned.tree.sha);
        trees.set(pin, new Map([...entries].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))));
      }
      return trees.get(pin);
    },
    blobs(ids) {
      const result = new Map();
      let size = 0;
      for (const object of new Set(ids)) {
        if (!commit.test(object)) throw Error('Invalid Base API blob identity');
        if (!objects.has(object)) {
          const blob = request(`git/blobs/${object}`);
          if (blob.sha !== object || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw Error('Invalid Base API blob');
          const bytes = Buffer.from(blob.content, 'base64');
          if (blob.size !== bytes.length || objectId(bytes) !== object) throw Error('Base API blob integrity mismatch');
          objects.set(object, bytes);
        }
        const bytes = objects.get(object);
        size += bytes.length;
        if (size > limit) throw Error('Base API source output exceeds the 64 MiB acquisition limit');
        result.set(object, bytes);
      }
      return result;
    },
    digests(ids) { return new Map([...this.blobs(ids)].map(([object, bytes]) => [object, hash(bytes)])); },
    contains(pin, introduced) {
      if (!commit.test(pin) || !commit.test(introduced)) throw Error('Base API ancestry requires immutable full commits');
      const key = introduced + '...' + pin;
      if (!ancestry.has(key)) {
        const comparison = request(`compare/${key}?per_page=1`);
        if (comparison.base_commit?.sha !== introduced || !commit.test(comparison.merge_base_commit?.sha) ||
            !['ahead', 'identical', 'behind', 'diverged'].includes(comparison.status)) throw Error('Invalid Base API ancestry comparison');
        if (['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit.sha !== introduced) throw Error('Invalid Base API ancestry proof');
        ancestry.set(key, ['ahead', 'identical'].includes(comparison.status));
      }
      return ancestry.get(key);
    },
    history(pin, name) {
      const entry = this.tree(pin).get(safe(name));
      return entry ? [{revision: pin, ...entry}] : [];
    },
  };
}

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
    // A single observed snapshot can match current template bytes; it cannot
    // establish older revisions or ancestry.
    history(pin, name) {
      if (pin !== revision) return history();
      const entry = orderedTree.get(safe(name));
      return entry ? [{revision, object: entry.object}] : [];
    },
  };
}
