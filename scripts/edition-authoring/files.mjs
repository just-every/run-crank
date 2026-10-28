import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {offlineRepository} from './offline-git.mjs';
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const json = value => JSON.stringify(value, null, 2) + '\n';
const environment = {...process.env, GIT_NO_REPLACE_OBJECTS: '1'};
export function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}
// Raw Git output, for committed source bytes. The limit fails explicitly rather than truncating.
function output(root, args, input, env = environment) {
  try {
    return execFileSync('git', ['-C', root, ...args], {env, input, maxBuffer: 64 * 1024 * 1024, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']});
  } catch (error) {
    if (error.code === 'ENOBUFS') throw Error('Git source output exceeds the 64 MiB acquisition limit');
    throw error;
  }
}
export const raw = (root, ...args) => output(root, args);
export const batch = (root, input, ...args) => output(root, args, input);
// Scope offline object access to this repository reader, never global state.
export function gitReader(root, offline = false) {
  const repository = offline ? offlineRepository(root) : {root, env: environment, close() {}};
  const read = (args, input) => {
    try { return output(repository.root, args, input, repository.env); }
    catch (error) {
      if (offline && typeof error.status === 'number') throw Error('Cannot read required Base objects offline. Run git -C <base-checkout> fsck to diagnose missing or corrupt local objects. If objects are missing locally, run rer refresh-base --ref <commit> --base <base-checkout> without --offline while online to acquire them, then retry offline. Repair corrupt objects before retrying. No copy record was changed.');
      throw error;
    }
  };
  return {git: (...args) => read(args).toString('utf8').trim(), raw: (...args) => read(args), batch: (input, ...args) => read(args, input), close: repository.close};
}
export function safe(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || path.posix.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) {
    throw Error(`Unsafe path: ${name}`);
  }
  return name;
}
// One physical spelling/type check for refresh writes and dependencies. Cache
// directory entries only for one read-only planning pass; removals take priority.
export function freedEntries(root) {
  const removed = new Set();
  const identity = (name, stat) => stat.nlink > 1 ? name : `${stat.dev}:${stat.ino}`;
  return {
    add: (name, stat) => removed.add(identity(name, stat)),
    has(relative, stat, parent) {
      if (stat.isFile()) return removed.has(identity(relative, stat));
      if (!parent || !stat.isDirectory() || !removed.size) return false;
      let found = false;
      const empty = directory => fs.readdirSync(directory).every(name => {
        const absolute = path.join(directory, name), child = fs.lstatSync(absolute);
        if (child.isDirectory()) return empty(absolute);
        const freed = child.isFile() && removed.has(identity(path.relative(root, absolute), child));
        found ||= freed;
        return freed;
      });
      return empty(path.join(root, relative)) && found;
    },
  };
}
export function physicalEntry(root, name, {cache = new Map(), freed = () => false} = {}) {
  let parent = root, parentStat = fs.lstatSync(root);
  const parts = safe(name).split('/');
  for (const [i, part] of parts.entries()) {
    const target = path.join(parent, part), relative = parts.slice(0, i + 1).join('/');
    let stat;
    try { stat = fs.lstatSync(target); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (!stat || freed(relative, stat, i < parts.length - 1)) return {absent: true, parent, parentStat};
    if (!cache.has(parent)) cache.set(parent, fs.readdirSync(parent));
    const entries = cache.get(parent);
    if (!entries.includes(part)) {
      const physical = entries.find(entry => {
        const other = fs.lstatSync(path.join(parent, entry));
        return other.dev === stat.dev && other.ino === stat.ino;
      });
      return {kind: 'alias', path: relative, physical: path.relative(root, path.join(parent, physical ?? part))};
    }
    if (stat.isSymbolicLink()) return {kind: 'symlink', path: relative};
    if (i < parts.length - 1 && !stat.isDirectory()) return {kind: 'non-directory parent', path: relative};
    if (i === parts.length - 1) return stat.isFile() ? {stat, target, parent, parentStat} : {kind: 'non-regular', path: relative};
    parent = target; parentStat = stat;
  }
}
export function requirePhysical(root, name, options) {
  const entry = physicalEntry(root, name, options);
  if (entry.kind) {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const indexed = raw(root, '--literal-pathspecs', 'ls-files', '--', entry.path).length > 0;
    const command = `backup=$(mktemp -d) && mv -- ${quote(entry.physical ?? entry.path)} "$backup/"${indexed ? ' && git restore -- ' + quote(entry.path) : ''}`;
    const reason = entry.kind === 'symlink' ? 'Symlink in destination path' : entry.kind === 'non-regular' ? 'destination is not a regular file' : entry.kind;
    throw Error(`Cannot refresh ${name}: ${reason} at ${entry.physical ?? entry.path}. Run ${command}, then repeat refresh-base; no files were refreshed.`);
  }
  return entry;
}
export function noLinks(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw Error(`Symlink in destination path: ${relative} (${path.relative(root, current)})`);
  }
}
export function tracked(root, allowMissing = false) {
  const result = Object.create(null);
  for (const name of git(root, 'ls-files', '-z').split('\0').filter(Boolean)) {
    safe(name);
    if (name === 'sources.lock.json' || name.startsWith('.edition/')) continue;
    noLinks(root, name);
    if (allowMissing && !fs.existsSync(path.join(root, name))) continue;
    const stat = fs.statSync(path.join(root, name));
    if (!stat.isFile()) throw Error(`Unsupported tracked source: ${name}`);
    result[name] = {data: fs.readFileSync(path.join(root, name)).toString('base64'), executable: !!(stat.mode & 0o111)};
  }
  return result;
}
export const digest = files => hash(json(files));
// The complete tool in `dir`, as sorted relative paths: its non-test modules and
// every vendored parser file with its licence. Copies and the lock identity use it.
export function toolFiles(dir) {
  const modules = fs.readdirSync(dir).filter(p => p.endsWith('.mjs') && !p.endsWith('.test.mjs'));
  const vendored = fs.readdirSync(path.join(dir, 'vendor'), {recursive: true, withFileTypes: true}).filter(entry => {
    if (!entry.isFile() && !entry.isDirectory()) throw Error(`Unsupported vendored tool entry: ${entry.name}`);
    return entry.isFile();
  }).map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  return [...modules, ...vendored].sort();
}
// Base's test, fixture and browser-check sources, which portable copies leave out.
// Composition pins its tooling alone, so composition/git-source.mjs keeps its own copy.
export function testSource(path) {
  return path.split('/').some(part => ['test', 'tests', 'fixtures'].includes(part)) ||
    /(?:\.test\.[^/]+|(?:^|\/)test-manifest-support\.mjs$|(?:^|\/)(?:test-fixture|[^/]+-fixture)\.(?:mjs|cjs)$|(?:^|\/)(?:tests|test_[^/]+|[^/]*_tests)\.py|(?:^|\/)browser-(?:check|output)\.mjs)$/.test(path);
}
export function writeTree(root, files) {
  // Validate the complete destination set before writing any selected source.
  for (const name of Object.keys(files)) {
    safe(name); noLinks(root, name);
    if (fs.existsSync(path.join(root, name))) throw Error(`Source destination already exists: ${name}`);
  }
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, Buffer.from(value.data, 'base64'), {mode: value.executable ? 0o755 : 0o644, flag: 'wx'});
  }
}
export function fresh(destination, root) {
  let absolute = path.resolve(destination);
  let parent = path.dirname(absolute);
  let tail = path.basename(absolute);
  while (!fs.existsSync(parent)) {
    tail = path.join(path.basename(parent), tail);
    parent = path.dirname(parent);
  }
  absolute = path.join(fs.realpathSync(parent), tail);
  if (absolute === root || absolute.startsWith(root + path.sep) || fs.existsSync(absolute)) throw Error('Output must be absent and outside edition');
  return absolute;
}
