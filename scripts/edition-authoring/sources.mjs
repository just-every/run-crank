import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {hash, json, git, raw, safe, digest, noLinks} from './files.mjs';
import {snapshotOrigin, verifyProjectionLock} from './projection-lock.mjs';

const environment = {...process.env, GIT_NO_REPLACE_OBJECTS: '1'};
function selected(name, ref) {
  const prefix = ref.path && ref.path !== '.' ? ref.path : '';
  if (prefix && name !== prefix && !name.startsWith(prefix + '/')) return false;
  const relative = prefix ? (name === prefix ? path.basename(name) : name.slice(prefix.length + 1)) : name;
  if (ref.excludeSnapshots && relative.startsWith('.edition/sources/')) return false;
  if (ref.paths && !ref.paths.some(p => relative === p || relative.startsWith(p + '/'))) return false;
  return relative;
}
function committed(root, ref, archives) {
  const files = Object.create(null);
  const entries = raw(root, 'ls-tree', '-rz', '--full-tree', ref.revision).toString('utf8').split('\0').filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const [mode, type, object] = entry.slice(0, tab).split(' ');
    const name = entry.slice(tab + 1);
    if (ref.excludeSnapshots && name.startsWith('.edition/sources/') && /^\.edition\/sources\/[a-f0-9]{64}\.json$/.test(name)) {
      if (type !== 'blob' || mode !== '100644') throw Error('Unsupported comparison archive');
      const archived = JSON.parse(raw(root, 'cat-file', 'blob', object));
      if (archived.key !== path.basename(name, '.json') || archived.key !== hash(json(archived.origin)) || archived.digest !== digest(archived.files)) throw Error('Corrupt ancestor comparison archive');
      archives[archived.key] = archived;
      continue;
    }
    const relative = selected(name, ref);
    if (relative === false) continue;
    safe(relative);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw Error(`Unsupported committed source: ${name}`);
    files[relative] = {data: raw(root, 'cat-file', 'blob', object).toString('base64'), executable: mode === '100755'};
  }
  return files;
}
export function snapshot(root, ref, retain = false) {
  if (ref.projection && ref.workspace) throw Error('Public projections cannot select workspace source');
  const origin = snapshotOrigin(ref);
  const key = hash(json(origin));
  noLinks(root, '.edition/sources/' + key + '.json');
  const filename = path.join(root, '.edition/sources', key + '.json');
  if (fs.existsSync(filename)) {
    if (!fs.lstatSync(filename).isFile()) throw Error('Retained source snapshot must be a regular file');
    const bytes = fs.readFileSync(filename);
    const saved = JSON.parse(bytes);
    if (saved.key !== key || json(saved.origin) !== json(origin) || saved.digest !== digest(saved.files)) throw Error('Corrupt retained source snapshot');
    if (ref.projection) verifyProjectionLock(root, origin, saved, bytes);
    for (const dependency of saved.dependencies || []) {
      noLinks(root, '.edition/sources/' + dependency.key + '.json');
      const ancestor = JSON.parse(fs.readFileSync(path.join(root, '.edition/sources', dependency.key + '.json')));
      if (ancestor.digest !== dependency.digest || digest(ancestor.files) !== dependency.digest || hash(json(ancestor)) !== dependency.sha256) {
        throw Error('Missing or corrupt ancestor comparison archive');
      }
    }
    return saved;
  }
  // A projection has no fetchable revision; it exists only as a reviewed retained archive.
  if (ref.projection) throw Error('Missing retained public projection; regenerate from the pinned private original outside the public tree');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'edition-source-'));
  try {
    execFileSync('git', ['clone', '--no-checkout', '--', ref.repository, temp], {env: environment, stdio: 'pipe'});
    if (git(temp, 'rev-parse', `${ref.revision}^{commit}`) !== ref.revision) throw Error('Source revision is not exact commit');
    const archives = Object.create(null);
    const files = committed(temp, ref, archives);
    if (!Object.keys(files).length) throw Error('Empty source export');
    const dependencies = Object.values(archives).map(a => ({key: a.key, digest: a.digest, sha256: hash(json(a))}));
    const saved = {key, origin, digest: digest(files), files, dependencies};
    if (retain) {
      fs.mkdirSync(path.dirname(filename), {recursive: true});
      for (const archive of Object.values(archives)) {
        noLinks(root, '.edition/sources/' + archive.key + '.json');
        fs.writeFileSync(path.join(root, '.edition/sources', archive.key + '.json'), json(archive));
      }
      fs.writeFileSync(filename, json(saved));
    }
    return saved;
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}
export function source(root, ref, dev = false, retain = false) {
  if (ref.projection && ref.workspace) throw Error('Public projections cannot select workspace source');
  if (!dev || !ref.workspace) return snapshot(root, ref, retain).files;
  if (fs.realpathSync(git(ref.workspace, 'rev-parse', '--show-toplevel')) !== fs.realpathSync(ref.workspace)) throw Error('Workspace must name the repository root');
  const files = Object.create(null);
  const index = raw(ref.workspace, 'ls-files', '--stage', '-z').toString('utf8').split('\0').filter(Boolean);
  for (const entry of index) {
    const [header, name] = entry.split('\t');
    if (selected(name, ref) !== false && header.startsWith('160000 ')) throw Error('Submodules are not source files');
  }
  const names = raw(ref.workspace, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean);
  for (const name of [...new Set(names)].sort()) {
    const relative = selected(name, ref);
    if (relative === false) continue;
    safe(name); safe(relative); noLinks(ref.workspace, name);
    const absolute = path.join(ref.workspace, name);
    if (!fs.existsSync(absolute)) continue; // A tracked deletion is a real workspace edit.
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) throw Error(`Unsupported workspace source: ${name}`);
    files[relative] = {data: fs.readFileSync(absolute).toString('base64'), executable: !!(stat.mode & 0o111)};
  }
  if (!Object.keys(files).length) throw Error('Empty workspace source export');
  return files;
}
export function merge(files, destination, ingredient) {
  for (const [name, value] of Object.entries(ingredient)) {
    const target = destination + '/' + safe(name);
    if (Object.keys(files).some(p => p === target || p.startsWith(target + '/') || target.startsWith(p + '/'))) throw Error(`Source collision: ${target}`);
    files[target] = value;
  }
}
