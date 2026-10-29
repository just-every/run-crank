import fs from 'node:fs';
import path from 'node:path';
import {git, raw, safe, noLinks, requirePhysical, freedEntries} from './files.mjs';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// -v marks assume-unchanged; -f marks fsmonitor-valid. Read them separately
// because either option can lowercase the normal checkout-state tag.
function index(root) {
  try {
    const read = flag => new Map(raw(root, 'ls-files', '--stage', flag, '-z').toString('utf8').split('\0').filter(Boolean).map(line => {
      const match = /^([HSMRCK?hsmrck]) ([0-7]{6}) ([a-f0-9]{40,64}) 0\t(.+)$/.exec(line);
      if (!match) throw Error('Unsupported index entry');
      return [safe(match[4]), {tag: match[1], mode: match[2], object: match[3]}];
    }));
    const entries = read('-v'), monitor = read('-f');
    if (entries.size !== monitor.size) throw Error('Index changed');
    for (const [name, entry] of entries) {
      const other = monitor.get(name);
      if (!other || entry.mode !== other.mode || entry.object !== other.object) throw Error('Index changed');
      entry.monitor = other.tag;
    }
    return entries;
  } catch {
    throw Error('Cannot read or interpret the Git index to decide whether Base copies were removed. Run git status and repair the checkout, then repeat refresh-base. No copy record was changed.');
  }
}

// Absence alone is a removal signal only in a complete checkout. For a
// materialized submodule, inspect its own index and read the recorded child;
// the parent index lists the gitlink, never the child's files.
export function requireMaterializedCopies(root, record, files) {
  const indexes = new Map();
  const entriesAt = directory => {
    if (!indexes.has(directory)) indexes.set(directory, index(directory));
    return indexes.get(directory);
  };
  entriesAt(root);
  for (const name of record.copies.flatMap(copy => Object.keys(copy.files))) {
    let directory = root, relative = name;
    for (;;) {
      const entries = entriesAt(directory), entry = entries.get(relative);
      const link = [...entries].find(([prefix, value]) => value.mode === '160000' && relative.startsWith(prefix + '/'));
      if (link) {
        const prefix = path.relative(root, path.join(directory, link[0])).split(path.sep).join('/');
        const child = path.join(root, prefix);
        let initialized = false;
        try { initialized = fs.realpathSync(git(child, 'rev-parse', '--show-toplevel')) === fs.realpathSync(child); } catch { initialized = false; }
        if (!initialized) throw Error(`Base copy ${name} is beneath the uninitialized Git submodule ${prefix}. Run git -C ${quote(directory)} submodule update --init -- ${quote(link[0])}, then repeat refresh-base. No copy record was changed.`);
        relative = relative.slice(link[0].length + 1);
        directory = child;
        continue;
      }
      const target = path.join(root, name);
      if (!fs.existsSync(target)) {
        const repairs = [];
        if (entry?.tag.toUpperCase() === 'S') repairs.push('git sparse-checkout disable');
        if (entry && entry.tag === entry.tag.toLowerCase()) repairs.push(`git update-index --no-assume-unchanged -- ${quote(relative)}`);
        if (entry && entry.monitor === entry.monitor.toLowerCase()) repairs.push(`git update-index --no-fsmonitor-valid -- ${quote(relative)}`);
        if (directory !== root) repairs.push(`git restore -- ${quote(relative)}`);
        if (repairs.length) throw Error(`Base copy ${name} has incomplete Git checkout evidence, not a confirmed removal. In ${directory}, run ${repairs.join(', then ')}, restore the file if absent, then repeat refresh-base. No copy record was changed.`);
      } else if (directory !== root) {
        noLinks(root, name);
        const stat = fs.lstatSync(target);
        files.set(name, {regular: stat.isFile(), executable: !!(stat.mode & 0o100), read: () => fs.readFileSync(target)});
      }
      break;
    }
  }
}

// Inspect real filesystem facts in apply order without opening or changing any
// file. This cannot see later races, disk-space or I/O failures, umask on newly
// created directories, or two new names differing only in case on an insensitive
// volume. Only earlier removals are remembered; no future directory is modelled.
export function preflightRefresh(root, plans, recordPath, seedFiles) {
  const uid = process.geteuid?.(), freed = freedEntries(root);
  const writable = (target, stat, directory = false) => {
    if (uid === 0 && !(stat.mode & 0o222)) throw Error('no write permission bits');
    fs.accessSync(target, fs.constants.W_OK | (directory ? fs.constants.X_OK : 0));
  };
  const cache = new Map();
  function inspect(name) {
    return requirePhysical(root, name, {cache, freed: freed.has});
  }
  function check(name, operation) {
    try {
      const found = inspect(name), {parent, parentStat, target, stat} = found;
      if (operation === 'remove') {
        if (!stat) return;
        writable(parent, parentStat, true);
        if (uid !== undefined && uid !== 0 && (parentStat.mode & 0o1000) && uid !== parentStat.uid && uid !== stat.uid) throw Error('sticky parent and file are owned by another user');
        freed.add(name, stat);
      } else if (stat) {
        if (operation !== 'record' && !seedFiles.has(name)) throw Error('existing destination is ignored');
        writable(target, stat);
        if (operation !== 'record' && uid !== undefined && uid !== 0 && uid !== stat.uid) throw Error('file is owned by another user; cannot set its mode');
      } else writable(parent, parentStat, true);
    } catch (error) {
      throw Error(`Cannot refresh ${name}: ${error.message}. Fix the named path and its parent permissions before refreshing; no files were refreshed.`);
    }
  }
  for (const {copy, sources, removed} of plans) {
    for (const name of removed) check(name, 'remove');
    for (const [source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) check(copy.path + source.slice(copy.originPath.length), 'write');
  }
  check(recordPath, 'record');
}
