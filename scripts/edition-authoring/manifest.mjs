import fs from 'node:fs';
import path from 'node:path';
import {safe} from './files.mjs';
export const VERSION = '1.1.0';
const identity = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export function origin(value) {
  if (!value || typeof value.repository !== 'string' || !value.repository || value.repository.startsWith('-') || (!value.projection && !/^[a-f0-9]{40}$/.test(value.revision))) {
    throw Error('Source requires repository and immutable full commit');
  }
  if (value.projection) {
    const p = value.projection;
    if (value.revision !== undefined || p.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(p.originalSha256) || !/^[a-f0-9]{64}$/.test(p.recipeSha256) || Object.keys(p).sort().join(',') !== 'originalSha256,recipeSha256,schemaVersion') throw Error('Invalid public projection identity');
  }
  if (value.paths) {
    if (!Array.isArray(value.paths) || !value.paths.length) throw Error('Origin paths must be nonempty');
    value.paths.forEach(safe);
  }
  if (value.path !== undefined && value.path !== '.') safe(value.path);
}
export function manifest(root) {
  const recipe = JSON.parse(fs.readFileSync(path.join(root, 'edition.json'), 'utf8'));
  if (recipe.schemaVersion !== 1 || !identity.test(recipe.id)) throw Error('Invalid edition identity/schema');
  if (recipe.toolchain?.id !== 'runeditrun/edition-authoring' || recipe.toolchain.version !== VERSION) throw Error('Unsupported independently pinned toolchain');
  if (recipe.parent) origin(recipe.parent);
  if (!Array.isArray(recipe.components)) throw Error('Components required');
  const ids = new Set();
  const paths = [];
  let foundations = 0;
  for (const component of recipe.components) {
    if (!identity.test(component.id) || ids.has(component.id)) throw Error('Duplicate/invalid publisher-qualified component');
    ids.add(component.id);
    if (!['edition', 'module', 'family', 'foundation'].includes(component.role)) throw Error('Invalid component role');
    if (component.role === 'foundation') foundations++;
    const selected = component.source;
    if (selected?.kind === 'local') {
      if (!Array.isArray(selected.paths) || !selected.paths.length) throw Error('Local source paths required');
      selected.paths.forEach(p => paths.push(safe(p)));
      if (selected.origin) origin(selected.origin);
      for (const mapping of selected.mappings || []) {
        safe(mapping.path); safe(mapping.originPath);
        if (!selected.origin || !selected.paths.some(p => mapping.path === p || mapping.path.startsWith(p + '/'))) {
          throw Error('Mapping outside local source or missing origin');
        }
      }
    } else if (selected?.kind === 'git') {
      origin(selected);
      paths.push(safe(selected.destination));
      if (selected.workspace && !path.isAbsolute(selected.workspace)) throw Error('Workspace must be an explicit absolute checkout');
    } else throw Error('Unknown source kind');
  }
  for (const component of recipe.components) {
    for (const required of component.requires || []) if (!ids.has(required)) throw Error(`Missing selected dependency: ${required}`);
    for (const conflict of component.conflicts || []) if (ids.has(conflict)) throw Error(`Conflicting selected component: ${conflict}`);
  }
  if (foundations > 1) throw Error('Select one runtime foundation');
  for (let i = 0; i < paths.length; i++) {
    if (paths[i] === 'edition.json' || paths[i] === 'sources.lock.json' || paths[i].startsWith('.edition')) throw Error('Reserved source destination');
    for (let j = 0; j < i; j++) {
      if (paths[i] === paths[j] || paths[i].startsWith(paths[j] + '/') || paths[j].startsWith(paths[i] + '/')) {
        throw Error(`Colliding source paths: ${paths[i]} and ${paths[j]}`);
      }
    }
  }
  return recipe;
}
