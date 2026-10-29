// Base declares edition edits; consent permits refresh, never edits seed data.
import {safe} from './files.mjs';
import {fileURLToPath} from 'node:url';
const dataPath = 'foundation/edition-migrations.json';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function editionMigrations(record, {tree, read, revision, base, recordPath, offline, consent = []}) {
  let migrations = [];
  const fail = reason => { throw Error(`Base edition migration data error: ${reason}. Repair ${dataPath} in Base and commit it, then refresh to that commit; no files were refreshed.`); };
  if (tree.has(dataPath)) {
    try {
      const data = JSON.parse(read.blobs([tree.get(dataPath).object]).get(tree.get(dataPath).object));
      if (data.schemaVersion !== 1 || !Array.isArray(data.migrations)) fail('invalid schema');
      const ids = new Set();
      for (const step of data.migrations) {
        if (!step || !/^[a-z][a-z0-9-]+$/.test(step.id) || ids.has(step.id) || !/^[a-f0-9]{40}$/.test(step.introduced) ||
            typeof step.guide !== 'string' || !step.guide || typeof step.edit !== 'string' || !step.edit ||
            !Array.isArray(step.deliver) || step.deliver.some(name => typeof name !== 'string')) fail('invalid entry');
        safe(step.origin); safe(step.guide); step.deliver.forEach(safe);
        if (read.historyAvailable !== false) read.tree(step.introduced);
        for (const name of step.deliver) if (!tree.has(name)) fail(`missing delivery ${name}`);
        ids.add(step.id);
      }
      migrations = data.migrations;
    } catch (error) { fail(error.message); }
  }
  for (const id of consent) if (!migrations.some(step => step.id === id)) throw Error(`Unknown edition migration ${id} at Base ${revision}. Use only ids declared in ${dataPath} at that commit; no files were refreshed.`);
  const applicable = migrations.flatMap(step => {
    // No introduction can be crossed by an unrelated copy or a same-pin
    // refresh. Archives can decide those cases without claiming Git ancestry.
    const candidates = record.copies.flatMap(copy => copy.revision === revision ? [] : Object.keys(copy.files).filter(name =>
      !copy.adapted?.[name] && copy.originPath + name.slice(copy.path.length) === step.origin).map(name => ({name, revision: copy.revision})));
    if (!candidates.length) return [];
    if (!read.contains(revision, step.introduced)) return [];
    const copies = candidates.filter(copy => !read.contains(copy.revision, step.introduced)).map(copy => copy.name);
    return copies.length ? [{...step, copies}] : [];
  });
  const missing = applicable.filter(step => !consent.includes(step.id));
  if (missing.length) {
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    // Keep automatic acquisition automatic: its temporary checkout closes on refusal.
    const command = `${quote(process.execPath)} ${quote(cli)} refresh-base ${revision}${base ? ' --base ' + quote(base) : ''} --record ${quote(recordPath)}${offline ? ' --offline' : ''}${applicable.map(step => ' --edition-migration ' + step.id).join('')}`;
    throw Error(`Edition migrations require consent before planning:\n${missing.map(step => `${step.id}: ${step.copies.join(', ')}; ${step.guide}: ${step.edit}`).join('\n')}\nReview the guides and repeat exactly: ${command}\nRefresh will leave these edition-owned edits owed; no files were refreshed.`);
  }
  return applicable;
}
