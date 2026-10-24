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
export function noLinks(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw Error('Symlink in destination path');
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
