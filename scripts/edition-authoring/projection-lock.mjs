import fs from 'node:fs';
import path from 'node:path';
import {manifest} from './manifest.mjs';
import {hash, json, noLinks} from './files.mjs';

export function snapshotOrigin(ref) {
  return {repository: ref.repository, ...(ref.projection ? {projection: ref.projection} : {revision: ref.revision}), path: ref.path || '.', paths: ref.paths || null, excludeSnapshots: !!ref.excludeSnapshots};
}

export function verifyProjectionLock(root, origin, saved, bytes) {
  noLinks(root, 'edition.json');
  noLinks(root, 'sources.lock.json');
  if (!fs.existsSync(path.join(root, 'sources.lock.json'))) throw Error('Public projection requires a selected source-lock binding');
  for (const name of ['edition.json', 'sources.lock.json']) {
    if (!fs.lstatSync(path.join(root, name)).isFile()) throw Error('Public projection selection and lock must be regular files');
  }
  const recipe = manifest(root);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'sources.lock.json')));
  if (lock.schemaVersion !== 1 || lock.edition !== recipe.id) throw Error('Public projection source lock identifies a different edition');
  const pins = [];
  const matches = ref => ref?.projection && json(snapshotOrigin(ref)) === json(origin);
  if (recipe.parent && matches({...recipe.parent, excludeSnapshots: true})) pins.push(lock.parent);
  for (const component of recipe.components) {
    const ref = component.source.kind === 'git' ? component.source : component.source.origin;
    if (!matches(ref)) continue;
    const locked = lock.components?.find(entry => entry.id === component.id);
    const lockedRef = locked?.source?.kind === 'git' ? locked.source : locked?.source?.origin;
    if (!matches(lockedRef)) throw Error('Public projection selection differs from source lock');
    pins.push(locked.baseline);
  }
  if (!pins.length) throw Error('Public projection is not selected by this edition');
  const rawSha256 = hash(bytes);
  for (const expected of pins) {
    if (!expected || expected.key !== saved.key || expected.digest !== saved.digest || expected.sha256 !== rawSha256) {
      throw Error('Public projection artifact differs from source lock');
    }
  }
}
