import fs from 'node:fs';
import path from 'node:path';
import {VERSION} from './manifest.mjs';
import {resolveSources} from './lock.mjs';
import {validate} from './base-copies.mjs';
import {git, json, noLinks, tracked, writeTree} from './files.mjs';

// Existing source and copy/composition provenance stay authoritative. Adoption
// adds a local-source recipe and lock; it does not regenerate the product or
// manufacture an upstream origin for source the seed already owns.
export function adoptEdition(root) {
  if (fs.realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== fs.realpathSync(root)) throw Error('Run adoption at the edition Git repository root.');
  for (const name of ['edition.json', 'sources.lock.json', 'base-copies.json', 'rer-project.json', 'OPERATIONS.json']) noLinks(root, name);
  if (fs.existsSync(path.join(root, 'edition.json')) || fs.existsSync(path.join(root, 'sources.lock.json'))) throw Error('Edition authoring inputs already exist. Preserve them; inspect and lock with the existing edition-authoring CLI instead of adopting again.');
  const read = name => fs.existsSync(path.join(root, name)) ? JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) : {};
  const id = read('rer-project.json').projectId ?? read('OPERATIONS.json').project;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw Error('Declare a publisher-qualified projectId in rer-project.json before rer adopt-edition.');
  const files = tracked(root);
  const paths = Object.keys(files).filter(name => !['edition.json', 'sources.lock.json'].includes(name) && !name.startsWith('.edition'));
  if (!paths.length) throw Error('Adoption needs tracked edition source. Add the intended source with git add, then repeat rer adopt-edition.');
  const hasRecord = fs.existsSync(path.join(root, 'base-copies.json'));
  if (hasRecord) validate(read('base-copies.json'));
  const recipe = {schemaVersion: 1, id, toolchain: {id: 'runeditrun/edition-authoring', version: VERSION}, parent: null,
    components: [{id, role: 'edition', source: {kind: 'local', paths}}]};
  const created = [];
  try {
    const put = (name, value) => { writeTree(root, {[name]: {data: Buffer.from(json(value)).toString('base64'), executable: false}}); created.push(name); };
    put('edition.json', recipe);
    if (!hasRecord) put('base-copies.json', {schemaVersion: 1, copies: []});
    const record = path.join(root, 'base-copies.json');
    const additional = {'base-copies.json': {data: fs.readFileSync(record).toString('base64'), executable: !!(fs.statSync(record).mode & 0o111)}};
    put('sources.lock.json', resolveSources(root, false, false, additional));
  } catch (error) {
    for (const name of created) fs.rmSync(path.join(root, name));
    throw error;
  }
  return {adopted: id, created, record: 'base-copies.json', preservedCopyRecord: hasRecord,
    next: 'Review git diff and git status; stage edition.json, sources.lock.json and any untracked base-copies.json. Existing copy and composition provenance is preserved. An empty copy record claims no Base copies; record known copies before refreshing. Run the edition tests before committing.'};
}
