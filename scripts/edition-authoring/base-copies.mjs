// Verbatim copies of maintained Base source inside an edition. A record names
// each copied path, its Base origin path and commit, and the SHA-256 of every
// copied file. Verification checks local bytes against the record, the record
// against Base at that commit, and looks for Base files copied without a record.
// The full commit and file digests identify Base bytes wherever Base is hosted, so
// the record names no repository; Base is read from --base or the seed's declared
// Base source. Older records naming a repository are still read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {hash, json, git, raw, batch, safe, noLinks, testSource} from './files.mjs';

export const RECORD = 'base-copies.json';
const commit = /^[a-f0-9]{40}$/, sha256 = /^[a-f0-9]{64}$/;
const FILE_MODES = ['100644', '100755'];
// Unrecorded-copy detection skips files under this many bytes: a one-line file such
// as CLAUDE.md holding `@AGENTS.md` equals Base's by coincidence, not by copying.
export const MIN_UNRECORDED_BYTES = 16;
// Root licence and agent pointers commonly match by convention, not shared source.
const DEFAULT_DISCOVERY_IGNORES = new Set(['LICENSE', 'CLAUDE.md']);
const modeOf = executable => executable ? '100755' : '100644';
const within = (name, prefix) => name === prefix || name.startsWith(prefix + '/');
const mapped = (name, from, to) => to + name.slice(from.length);

function baseRepository(root) {
  const recipe = path.join(root, 'edition.json');
  if (!fs.existsSync(recipe)) return 'runeditrun/base';
  const component = JSON.parse(fs.readFileSync(recipe, 'utf8')).components?.find(c => c.id === 'runeditrun/base');
  const source = component?.source;
  return (source?.kind === 'git' ? source.repository : source?.origin?.repository) || 'runeditrun/base';
}

// An explicit checkout, else the record's legacy repository, else the seed's declaration.
function open(record, base, root) {
  if (base) {
    const repository = fs.realpathSync(base);
    return {repository, head: git(repository, 'rev-parse', 'HEAD'), close() {}};
  }
  const source = record.repository ?? baseRepository(root);
  if (source === 'runeditrun/base') throw Error('Base has a publisher-qualified identity only; pass --base <checkout> or --offline');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'base-copies-'));
  try {
    execFileSync('git', ['clone', '--bare', '--quiet', '--', source, temporary], {env: {...process.env, GIT_NO_REPLACE_OBJECTS: '1'}, stdio: 'pipe'});
  } catch {
    fs.rmSync(temporary, {recursive: true, force: true});
    throw Error(`Cannot read Base repository ${source}; pass --base <checkout> or --offline`);
  }
  return {repository: temporary, head: null, close: () => fs.rmSync(temporary, {recursive: true, force: true})};
}

export function options(args, count) {
  const result = {positional: [], record: RECORD, base: null, offline: false};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--offline') result.offline = true;
    else if (arg === '--record' || arg === '--base') {
      if (!args[i + 1]) throw Error(`${arg} requires a value`);
      result[arg.slice(2)] = args[++i];
    } else if (arg.startsWith('--')) throw Error(`Unknown option: ${arg}`);
    else result.positional.push(arg);
  }
  if (result.positional.length !== count) throw Error('Usage: verify-base [--record <file>] [--base <checkout>] [--offline] | record-base <path> <origin-path> <revision> [--record <file>] [--base <checkout>] | refresh-base <revision> [--record <file>] [--base <checkout>]');
  safe(result.record);
  return result;
}

export function validate(record) {
  const legacy = record?.repository;
  if (record?.schemaVersion !== 1 || (legacy !== undefined && (typeof legacy !== 'string' || !legacy || legacy.startsWith('-'))) || !Array.isArray(record.copies)) {
    throw Error('Invalid Base copy record');
  }
  const paths = [];
  for (const copy of record.copies) {
    if (!copy || typeof copy !== 'object' || !commit.test(copy.revision) || !copy.files || typeof copy.files !== 'object' || Array.isArray(copy.files) || !Object.keys(copy.files).length) {
      throw Error(`Invalid Base copy: ${copy?.path}`);
    }
    safe(copy.path); safe(copy.originPath);
    for (const [name, digest] of Object.entries(copy.files)) {
      safe(name);
      if (!within(name, copy.path) || !sha256.test(digest)) throw Error(`Invalid recorded copy file: ${name}`);
    }
    // Older records have no modes, and a file without a recorded mode is not mode-checked; record-base writes every one.
    if (copy.modes !== undefined) {
      if (!copy.modes || typeof copy.modes !== 'object' || Array.isArray(copy.modes)) throw Error(`Invalid recorded modes: ${copy.path}`);
      for (const [name, mode] of Object.entries(copy.modes)) {
        if (!Object.hasOwn(copy.files, name) || !FILE_MODES.includes(mode)) throw Error(`Invalid recorded mode: ${name}`);
      }
    }
    for (const other of paths) if (within(copy.path, other) || within(other, copy.path)) throw Error(`Overlapping Base copies: ${other} and ${copy.path}`);
    paths.push(copy.path);
  }
  if (record.ignore !== undefined && !Array.isArray(record.ignore)) throw Error('Ignored paths must be a list');
  (record.ignore || []).forEach(safe);
  return record;
}

// Every tracked and nonignored untracked file, as Git and the next commit see it.
function seedFiles(root) {
  if (fs.realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== fs.realpathSync(root)) throw Error('Run at the edition repository root');
  const files = new Map();
  const names = raw(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean);
  for (const name of [...new Set(names)].sort()) {
    safe(name);
    let stat;
    try { stat = fs.lstatSync(path.join(root, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    files.set(name, {regular: stat.isFile(), executable: !!(stat.mode & 0o100), read: () => fs.readFileSync(path.join(root, name))});
  }
  return files;
}

function reader(origin) {
  const format = git(origin.repository, 'rev-parse', '--show-object-format');
  const trees = new Map();
  return {
    // Git object identity of local bytes, to find copies by content without reading Base blobs.
    objectId: bytes => crypto.createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    tree(revision) {
      if (!trees.has(revision)) {
        let resolved;
        try { resolved = git(origin.repository, 'rev-parse', '--verify', '--quiet', `${revision}^{commit}`); } catch { resolved = ''; }
        if (resolved !== revision) throw Error(`Base commit ${revision} is not available`);
        const entries = new Map();
        for (const entry of raw(origin.repository, 'ls-tree', '-rz', '--full-tree', revision).toString('utf8').split('\0').filter(Boolean)) {
          const tab = entry.indexOf('\t');
          const [mode, type, object] = entry.slice(0, tab).split(' ');
          if (type === 'blob' && FILE_MODES.includes(mode)) entries.set(entry.slice(tab + 1), {object, mode});
        }
        trees.set(revision, entries);
      }
      return trees.get(revision);
    },
    // Committed Base bytes, read in bounded batches.
    blobs(objects) {
      const result = new Map();
      const unique = [...new Set(objects)];
      for (let i = 0; i < unique.length; i += 100) {
        const chunk = unique.slice(i, i + 100);
        const output = batch(origin.repository, chunk.join('\n') + '\n', 'cat-file', '--batch');
        let offset = 0;
        for (const object of chunk) {
          const newline = output.indexOf(10, offset);
          const [, type, size] = output.subarray(offset, newline).toString('utf8').split(' ');
          if (type !== 'blob') throw Error(`Base object ${object} is not a file`);
          result.set(object, Buffer.from(output.subarray(newline + 1, newline + 1 + Number(size))));
          offset = newline + 1 + Number(size) + 1;
        }
      }
      return result;
    },
    digests(objects) {
      return new Map([...this.blobs(objects)].map(([object, bytes]) => [object, hash(bytes)]));
    },
  };
}

// The record is edition input: never read or write it through a link, and only as a regular file.
function recordFile(root, recordPath) {
  noLinks(root, recordPath);
  const filename = path.join(root, recordPath);
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile()) throw Error(`Base copy record is not a regular file: ${recordPath}`);
  return filename;
}

export function verifyCopies(root, {record: recordPath, base, offline}) {
  const filename = recordFile(root, recordPath);
  if (!filename) throw Error(`No ${recordPath} found; run record-base <path> <origin-path> <commit> first`);
  const record = validate(JSON.parse(fs.readFileSync(filename, 'utf8')));
  const files = seedFiles(root);
  const drift = [], unrecordedCopies = [];
  const copies = record.copies.map(copy => ({path: copy.path, originPath: copy.originPath, revision: copy.revision, files: Object.keys(copy.files).length}));
  for (const copy of record.copies) {
    for (const [name, file] of files) {
      if (!within(name, copy.path)) continue;
      if (!file.regular) drift.push({kind: 'not-a-file', path: name, copy: copy.path});
      else if (!Object.hasOwn(copy.files, name)) drift.push({kind: 'unrecorded', path: name, copy: copy.path});
      else {
        const actual = hash(file.read());
        if (actual !== copy.files[name]) drift.push({kind: 'modified', path: name, copy: copy.path, expected: copy.files[name], actual});
        if (copy.modes?.[name] && modeOf(file.executable) !== copy.modes[name]) drift.push({kind: 'mode', path: name, copy: copy.path, expected: copy.modes[name], actual: modeOf(file.executable)});
      }
    }
    for (const name of Object.keys(copy.files)) if (!files.has(name)) drift.push({kind: 'missing', path: name, copy: copy.path});
  }
  if (!offline) {
    const origin = open(record, base, root);
    try {
      const read = reader(origin);
      for (const [index, copy] of record.copies.entries()) {
        const tree = read.tree(copy.revision);
        const present = [];
        for (const [name, expected] of Object.entries(copy.files)) {
          const originPath = mapped(name, copy.path, copy.originPath);
          if (!tree.has(originPath)) drift.push({kind: 'origin-missing', path: name, originPath, revision: copy.revision});
          else {
            const {object, mode} = tree.get(originPath);
            present.push({name, originPath, expected, object});
            if (copy.modes?.[name] && mode !== copy.modes[name]) drift.push({kind: 'origin-mode', path: name, originPath, revision: copy.revision, expected: copy.modes[name], actual: mode});
          }
        }
        const digests = read.digests(present.map(item => item.object));
        for (const item of present) {
          const actual = digests.get(item.object);
          if (actual !== item.expected) drift.push({kind: 'origin-mismatch', path: item.name, originPath: item.originPath, revision: copy.revision, expected: item.expected, actual});
        }
        // Base files under the origin path that this copy deliberately leaves out.
        copies[index].notCopied = [...tree.keys()].filter(name => within(name, copy.originPath) &&
          !Object.hasOwn(copy.files, mapped(name, copy.originPath, copy.path)));
      }
      const known = new Map();
      const revisions = [...new Set([...record.copies.map(copy => copy.revision), ...(origin.head ? [origin.head] : [])])];
      for (const revision of revisions) for (const [name, {object}] of read.tree(revision)) if (!known.has(object)) known.set(object, {originPath: name, revision});
      for (const [name, file] of files) {
        if (!file.regular || name === recordPath || DEFAULT_DISCOVERY_IGNORES.has(name) || record.copies.some(copy => within(name, copy.path)) || (record.ignore || []).some(p => within(name, p))) continue;
        const bytes = file.read();
        if (bytes.length < MIN_UNRECORDED_BYTES) continue;
        const match = known.get(read.objectId(bytes));
        if (match) unrecordedCopies.push({path: name, ...match});
      }
    } finally { origin.close(); }
  }
  return {
    ok: !drift.length && !unrecordedCopies.length, record: recordPath, repository: record.repository,
    origin: offline ? 'not checked (--offline): local bytes against recorded SHA-256 only' : base ? 'local Base checkout' : 'fresh clone of the recorded repository',
    copies, drift, unrecordedCopies,
    meaning: 'A recorded copy claims byte equality with Base at its commit. Adapted source belongs in edition.json origins and mappings, compared with compare, not in this record.',
  };
}

export function recordCopy(root, {positional: [localPath, originPath, revision], record: recordPath, base}) {
  safe(localPath); safe(originPath);
  if (!commit.test(revision)) throw Error('Record an immutable full Base commit');
  const filename = recordFile(root, recordPath) || path.join(root, recordPath);
  const record = validate(fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {schemaVersion: 1, copies: []});
  const files = seedFiles(root);
  const origin = open(record, base, root);
  delete record.repository;
  try {
    const read = reader(origin);
    const sources = [...read.tree(revision)].filter(([name]) => within(name, originPath));
    if (!sources.length) throw Error(`No Base source at ${originPath} in ${revision}`);
    const present = sources.filter(([name]) => files.get(mapped(name, originPath, localPath))?.regular);
    if (!present.length) throw Error(`Copy Base ${originPath} into ${localPath} before recording it`);
    // The record states Base bytes, never local bytes; verification then compares the two.
    const digests = read.digests(present.map(([, {object}]) => object));
    const ordered = present.map(([name, {object, mode}]) => [mapped(name, originPath, localPath), digests.get(object), mode]).sort(([a], [b]) => a.localeCompare(b));
    const recorded = Object.fromEntries(ordered.map(([name, digest]) => [name, digest]));
    const modes = Object.fromEntries(ordered.map(([name, , mode]) => [name, mode]));
    record.copies = [...record.copies.filter(copy => copy.path !== localPath), {path: localPath, originPath, revision, files: recorded, modes}].sort((a, b) => a.path.localeCompare(b.path));
    validate(record);
    fs.writeFileSync(filename, json(record));
    return {
      recorded: localPath, originPath, revision, record: recordPath, files: present.length,
      notCopied: sources.filter(entry => !present.includes(entry)).map(([name]) => name),
      differs: Object.entries(recorded).filter(([name, digest]) => hash(files.get(name).read()) !== digest || modeOf(files.get(name).executable) !== modes[name]).map(([name]) => name),
      localOnly: [...files.keys()].filter(name => within(name, localPath) && !Object.hasOwn(recorded, name)),
      next: 'Run verify-base, then the edition tests, and commit the copied files with the record.',
    };
  } finally { origin.close(); }
}

// Move every recorded copy to one Base commit, after any export tool has written
// its files. Recorded files and files already equal to Base at that commit are
// kept current; files Base added under a copied path since the copy's pin are
// adopted (tests only into copies that carry tests); recorded files that Base or
// the export removed are dropped. Local edits are refused, never overwritten, and
// so is any change to an existing file under a migrations folder.
export function refreshCopies(root, {positional: [revision], record: recordPath, base}) {
  if (!commit.test(revision)) throw Error('Refresh to an immutable full Base commit');
  const filename = recordFile(root, recordPath);
  if (!filename) throw Error(`No ${recordPath} found; run record-base <path> <origin-path> <commit> first`);
  const record = validate(JSON.parse(fs.readFileSync(filename, 'utf8')));
  const files = seedFiles(root);
  const origin = open(record, base, root);
  try {
    const read = reader(origin);
    const next = read.tree(revision);
    const upstream = read.digests([...next.values()].map(({object}) => object));
    const local = name => files.get(name)?.regular ? hash(files.get(name).read()) : null;
    const edited = [];
    // Check every recorded path before planning removals too. A path absent
    // upstream still belongs to the owner when its local bytes have changed.
    for (const copy of record.copies) for (const [name, digest] of Object.entries(copy.files)) {
      const actual = local(name), source = next.get(mapped(name, copy.path, copy.originPath));
      if (actual && actual !== digest && actual !== (source && upstream.get(source.object))) edited.push(name);
    }
    if (edited.length) throw Error(`Recorded copies have local edits; move adapted source out of the record first: ${edited.join(', ')}`);
    const plans = record.copies.map(copy => {
      const pinned = read.tree(copy.revision);
      const tests = Object.keys(copy.files).some(name => testSource(mapped(name, copy.path, copy.originPath)));
      const sources = [...next].filter(([name, {object}]) => {
        if (!within(name, copy.originPath)) return false;
        const target = mapped(name, copy.originPath, copy.path), actual = local(target);
        if (Object.hasOwn(copy.files, target)) {
          return Boolean(actual);
        }
        if (actual) return actual === upstream.get(object);
        return !pinned.has(name) && (tests || !testSource(name));
      });
      if (!sources.length) throw Error(`No Base source at ${copy.originPath} in ${revision}`);
      return {copy, sources, removed: Object.keys(copy.files).filter(name => !sources.some(([source]) => mapped(source, copy.originPath, copy.path) === name))};
    });
    // A migration a database may already have applied is never rewritten in place:
    // the schema change it brings belongs in a new migration of the seed's own.
    const applied = plans.flatMap(({copy, sources}) => sources.map(([source, {object}]) => [mapped(source, copy.originPath, copy.path), object])
      .filter(([name, object]) => name.split('/').slice(0, -1).includes('migrations') && local(name) && local(name) !== upstream.get(object)).map(([name]) => name));
    if (applied.length) throw Error(`Refusing to rewrite migrations that may already be applied: ${applied.join(', ')}. Base changed these files after they were copied; keep them as they are, drop them from ${recordPath}, and add a new migration for the change instead.`);
    const bytes = read.blobs(plans.flatMap(plan => plan.sources.map(([, {object}]) => object)));
    const changes = [];
    for (const {copy, sources, removed} of plans) {
      for (const name of removed) { noLinks(root, name); fs.rmSync(path.join(root, name), {force: true}); }
      const recorded = {}, modes = {}, added = [];
      for (const [source, {object, mode}] of sources.sort(([a], [b]) => a.localeCompare(b))) {
        const name = safe(mapped(source, copy.originPath, copy.path));
        noLinks(root, name);
        if (!Object.hasOwn(copy.files, name)) added.push(name);
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, bytes.get(object));
        fs.chmodSync(target, mode === '100755' ? 0o755 : 0o644);
        recorded[name] = upstream.get(object); modes[name] = mode;
      }
      changes.push({path: copy.path, from: copy.revision, files: sources.length, added, removed});
      Object.assign(copy, {revision, files: recorded, modes});
    }
    delete record.repository;
    validate(record);
    fs.writeFileSync(filename, json(record));
    return {refreshed: revision, record: recordPath, copies: changes, next: 'Run verify-base, then the edition tests, and commit the copied files with the record.'};
  } finally { origin.close(); }
}
