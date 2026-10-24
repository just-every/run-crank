import fs from 'node:fs';
import path from 'node:path';
import {git, raw, safe, noLinks} from './files.mjs';
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
        try { initialized = fs.realpathSync(git(child, 'rev-parse', '--show-toplevel')) === fs.realpathSync(child); } catch {}
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
