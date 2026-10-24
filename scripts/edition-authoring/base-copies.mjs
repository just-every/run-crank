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
import {hash, json, git, raw, gitReader, safe, noLinks, testSource} from './files.mjs';
import {snapshot, acknowledgementDrift} from './base-acknowledgements.mjs';
import {requireMaterializedCopies} from './copy-checkout.mjs';

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
function open(record, base, root, offline = false) {
  if (base) {
    const repository = fs.realpathSync(base);
    const source = gitReader(repository, offline);
    try { return {repository, source, head: source.git('rev-parse', 'HEAD'), offline, close: source.close}; }
    catch (error) { source.close(); throw error; }
  }
  const declared = record.repository ?? baseRepository(root);
  const source = declared === 'runeditrun/base' ? 'https://github.com/runeditrun/base.git' : declared;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'base-copies-'));
  try {
    execFileSync('git', ['clone', '--bare', '--quiet', '--', source, temporary], {env: {...process.env, GIT_NO_REPLACE_OBJECTS: '1'}, stdio: 'pipe'});
  } catch {
    fs.rmSync(temporary, {recursive: true, force: true});
    throw Error('Cannot acquire Base source. Clone https://github.com/runeditrun/base.git when online, then repeat with --base <checkout>.');
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
  if (result.positional.length !== count) throw Error('Usage: verify-base [--record <file>] [--base <checkout>] [--offline] | record-base <path> <origin-path> <revision> [--record <file>] [--base <checkout>] | adapt-base <file> [--record <file>] | refresh-base <revision> [--record <file>] [--base <checkout>]');
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
    if (copy.adapted !== undefined) {
      if (!copy.adapted || typeof copy.adapted !== 'object' || Array.isArray(copy.adapted)) throw Error(`Invalid adaptations: ${copy.path}`);
      for (const [name, revision] of Object.entries(copy.adapted)) {
        if (!Object.hasOwn(copy.files, name) || !commit.test(revision)) throw Error(`Invalid adaptation: ${name}`);
      }
    }
    if (copy.acknowledged !== undefined) {
      if (!copy.acknowledged || typeof copy.acknowledged !== 'object' || Array.isArray(copy.acknowledged)) throw Error(`Invalid acknowledgements: ${copy.path}`);
      for (const [name, local] of Object.entries(copy.acknowledged)) {
        if (!Object.hasOwn(copy.adapted || {}, name) || !local || !sha256.test(local.sha256) || !FILE_MODES.includes(local.mode)) throw Error(`Invalid acknowledgement: ${name}`);
      }
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
  let top;
  try { top = git(root, 'rev-parse', '--show-toplevel'); }
  catch { throw Error('Cannot read the Git checkout/index. Ensure Git is available and run git status to repair the checkout before working with Base copies; no copy record was changed.'); }
  if (fs.realpathSync(top) !== fs.realpathSync(root)) throw Error('Run at the edition repository root');
  const files = new Map();
  let names;
  try { names = raw(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean); }
  catch { throw Error('Cannot read the Git index. Run git status and repair the checkout before working with Base copies; no copy record was changed.'); }
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
  const source = origin.source ?? gitReader(origin.repository);
  const format = source.git('rev-parse', '--show-object-format');
  const trees = new Map();
  return {
    // Git object identity of local bytes, to find copies by content without reading Base blobs.
    objectId: bytes => crypto.createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    tree(revision) {
      if (!trees.has(revision)) {
        let resolved;
        try { resolved = source.git('rev-parse', '--verify', '--quiet', `${revision}^{commit}`); } catch (error) { if (origin.offline) throw error; resolved = ''; }
        if (resolved !== revision) throw Error(`Base commit ${revision} is not available. Check the full commit with git -C <base-checkout> rev-parse <tag>^{commit}, fetch it, then repeat with --base <base-checkout>`);
        const entries = new Map();
        for (const entry of source.raw('ls-tree', '-rz', '--full-tree', revision).toString('utf8').split('\0').filter(Boolean)) {
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
        const output = source.batch(chunk.join('\n') + '\n', 'cat-file', '--batch');
        let offset = 0;
        for (const object of chunk) {
          const newline = output.indexOf(10, offset);
          const [, type, size] = output.subarray(offset, newline).toString('utf8').split(' ');
          if (type === 'missing' && origin.offline) throw Error(`Base object ${object} is missing locally. Repeat rer refresh-base --ref <commit> --base <base-checkout> without --offline while online to acquire it, then retry offline. No copy record was changed.`);
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
      else if (Object.hasOwn(copy.adapted || {}, name)) {
        noLinks(root, name);
        drift.push(...acknowledgementDrift(root, copy, name, file, recordPath));
      } else {
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
          const baseline = copy.adapted?.[name] || copy.revision;
          const tree = read.tree(baseline);
          if (!tree.has(originPath)) drift.push({kind: 'origin-missing', path: name, originPath, revision: baseline});
          else {
            const {object, mode} = tree.get(originPath);
            present.push({name, originPath, expected, object, revision: baseline});
            if (copy.modes?.[name] && mode !== copy.modes[name]) drift.push({kind: 'origin-mode', path: name, originPath, revision: baseline, expected: copy.modes[name], actual: mode});
          }
        }
        const digests = read.digests(present.map(item => item.object));
        for (const item of present) {
          const actual = digests.get(item.object);
          if (actual !== item.expected) drift.push({kind: 'origin-mismatch', path: item.name, originPath: item.originPath, revision: item.revision, expected: item.expected, actual});
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
    adapted: record.copies.flatMap(copy => Object.entries(copy.adapted || {}).map(([path, revision]) => ({path, revision}))),
    meaning: 'Undeclared copies claim Base byte equality. Declared adaptations must match their acknowledged local bytes and mode; their recorded Base bytes and revision remain comparison baselines.',
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

// Explicitly transfer one recorded file to seed ownership without changing its bytes
// or its Base digest/mode. The per-file revision survives later whole-copy refreshes.
export function adaptCopy(root, {positional: [name], record: recordPath}) {
  safe(name);
  const filename = recordFile(root, recordPath);
  if (!filename) throw Error(`No ${recordPath} found; run record-base first`);
  const record = validate(JSON.parse(fs.readFileSync(filename, 'utf8')));
  const copy = record.copies.find(copy => Object.hasOwn(copy.files, name));
  if (!copy) throw Error(`${name} is not a recorded Base copy file`);
  noLinks(root, name);
  const file = seedFiles(root).get(name);
  if (!file?.regular) throw Error(`Adaptation must be a regular file: ${name}`);
  copy.adapted ||= {};
  copy.adapted[name] ||= copy.revision;
  copy.acknowledged ||= {};
  copy.acknowledged[name] = snapshot(file);
  delete record.repository;
  fs.writeFileSync(filename, json(record));
  return {adapted: name, revision: copy.adapted[name], sha256: copy.files[name], acknowledged: copy.acknowledged[name], record: recordPath};
}

// Move every recorded copy to one Base commit, after any export tool has written
// its files. Recorded files and files already equal to Base at that commit are
// kept current; files Base added under a copied path since the copy's pin are
// adopted (tests only into copies that carry tests); recorded files that Base or
// the export removed are dropped. Absent unadapted singleton copies are retired
// entirely, just as absent files are dropped from directory copies. Local edits
// are refused, never overwritten, as is any change to an existing file under a
// migrations folder.
export function refreshCopies(root, {positional: [revision], record: recordPath, base, offline}) {
  if (!commit.test(revision)) throw Error('Refresh requires an immutable full 40-character Base commit. Resolve the release tag with git -C <base-checkout> rev-parse <tag>^{commit}, then repeat with --ref <commit> --base <base-checkout>.');
  if (offline && !base) throw Error('Offline refresh needs a Base checkout. Repeat rer refresh-base --ref <commit> --offline --base <checkout> containing that commit.');
  const filename = recordFile(root, recordPath);
  if (!filename) throw Error(`No ${recordPath} found; run record-base <path> <origin-path> <commit> first`);
  const record = validate(JSON.parse(fs.readFileSync(filename, 'utf8')));
  const files = seedFiles(root);
  requireMaterializedCopies(root, record, files);
  const origin = open(record, base, root, offline);
  try {
    const read = reader(origin);
    const next = read.tree(revision);
    const upstream = read.digests([...next.values()].map(({object}) => object));
    const local = name => files.get(name)?.regular ? hash(files.get(name).read()) : null;
    const edited = [], unacknowledged = [];
    // Check every recorded path before planning removals too. A path absent
    // upstream still belongs to the owner when its local bytes have changed.
    for (const copy of record.copies) for (const [name, digest] of Object.entries(copy.files)) {
      if (Object.hasOwn(copy.adapted || {}, name)) {
        noLinks(root, name);
        if (!files.get(name)?.regular) throw Error(`Adaptation must be a regular file: ${name}`);
        unacknowledged.push(...acknowledgementDrift(root, copy, name, files.get(name), recordPath));
        continue;
      }
      const actual = local(name), source = next.get(mapped(name, copy.path, copy.originPath));
      if (actual && actual !== digest && actual !== (source && upstream.get(source.object))) edited.push(name);
    }
    if (unacknowledged.length) throw Error(`Adapted files need acknowledgement: ${[...new Set(unacknowledged.map(item => item.path))].join(', ')}. Review local bytes and mode, then run:\n${[...new Set(unacknowledged.map(item => item.acknowledge))].join('\n')}`);
    if (edited.length) throw Error(`Recorded copies have local edits; move adapted source out of the record first: ${edited.join(', ')}. To keep each intentional adaptation, run adapt-base <file> first.`);
    const adapted = record.copies.flatMap(copy => Object.entries(copy.adapted || {}).map(([name, baseline]) => {
      const originPath = mapped(name, copy.path, copy.originPath);
      const source = next.get(originPath);
      const conflict = !source || upstream.get(source.object) !== copy.files[name] || Boolean(copy.modes?.[name] && source.mode !== copy.modes[name]);
      return {path: name, originPath, revision: baseline, conflict,
        ...(conflict ? {note: 'Upstream changed or removed this seed-owned adaptation; review and reconcile explicitly.',
          diffHint: `git -C <base> diff ${baseline} ${revision} -- ${JSON.stringify(originPath)}`} : {})};
    }));
    const plans = record.copies.map(copy => {
      // Absence is the existing directory-copy removal signal; there is no
      // separate deletion-intent marker. Only an absent, unadapted singleton
      // may retire its whole copy. Non-files and declared adaptations are not
      // removals, and a still-present singleton must retain a Base source.
      const retired = Object.keys(copy.files).length === 1 && Object.hasOwn(copy.files, copy.path) &&
        !files.has(copy.path) && !fs.existsSync(path.join(root, copy.path)) && !Object.hasOwn(copy.adapted || {}, copy.path);
      const pinned = read.tree(copy.revision);
      if (retired) return {copy, sources: [], retired, removed: [copy.path]};
      const tests = Object.keys(copy.files).some(name => testSource(mapped(name, copy.path, copy.originPath)));
      const sources = [...next].filter(([name, {object}]) => {
        if (!within(name, copy.originPath)) return false;
        const target = mapped(name, copy.originPath, copy.path), actual = local(target);
        if (Object.hasOwn(copy.adapted || {}, target)) return false;
        if (Object.hasOwn(copy.files, target)) {
          return Boolean(actual);
        }
        if (actual) return actual === upstream.get(object);
        return !pinned.has(name) && (tests || !testSource(name));
      });
      if (!sources.length && !Object.keys(copy.adapted || {}).length) throw Error(`No Base source at ${copy.originPath} in ${revision}`);
      return {copy, sources, retired, removed: Object.keys(copy.files).filter(name => !Object.hasOwn(copy.adapted || {}, name) && !sources.some(([source]) => mapped(source, copy.originPath, copy.path) === name))};
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
      for (const name of Object.keys(copy.adapted || {})) {
        recorded[name] = copy.files[name];
        if (copy.modes?.[name]) modes[name] = copy.modes[name];
      }
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
    record.copies = plans.filter(plan => !plan.retired).map(plan => plan.copy);
    delete record.repository;
    validate(record);
    fs.writeFileSync(filename, json(record));
    return {refreshed: revision, record: recordPath, copies: changes, retired: plans.filter(plan => plan.retired).map(plan => plan.copy.path), adapted, next: 'Run verify-base, then the edition tests, and commit the copied files with the record.'};
  } finally { origin.close(); }
}
