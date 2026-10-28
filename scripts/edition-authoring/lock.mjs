import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {manifest, VERSION} from './manifest.mjs';
import {snapshot, merge} from './sources.mjs';
import {hash, json, tracked, toolFiles} from './files.mjs';

function toolsIdentity() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const names = toolFiles(dir);
  const bytes = names.map(p => p + '\0' + fs.readFileSync(path.join(dir, p), 'utf8')).join('\0');
  return {id: 'runeditrun/edition-authoring', version: VERSION, sha256: hash(bytes)};
}
function includes(files, selected) {
  return Object.keys(files).some(p => p === selected || p.startsWith(selected + '/'));
}
export function resolveSources(root, retain = false, diagnostics = false, additionalFiles = {}) {
  const recipe = manifest(root);
  const files = Object.assign(tracked(root, diagnostics), additionalFiles);
  // The recipe is input even before initial adoption has staged it.
  files['edition.json'] ??= {data: fs.readFileSync(path.join(root, 'edition.json')).toString('base64'), executable: false};
  const components = [];
  for (const component of recipe.components) {
    const selected = component.source;
    if (selected.workspace) throw Error('Retain workspace edits by promotion or commit and exact revision selection before locking/release');
    const reference = selected.kind === 'git' ? selected : selected.origin;
    const baseline = reference ? snapshot(root, reference, retain) : null;
    if (selected.kind === 'git') merge(files, selected.destination, baseline.files);
    else for (const name of selected.paths) {
      if (!diagnostics && !includes(files, name)) throw Error(`Local source missing or untracked: ${name}`);
    }
    for (const mapping of selected.mappings || []) {
      if ((!diagnostics && !includes(files, mapping.path)) || !baseline || !includes(baseline.files, mapping.originPath)) {
        throw Error('Mapping names missing local or retained origin source');
      }
    }
    components.push({id: component.id, source: selected, baseline: baseline ? {key: baseline.key, digest: baseline.digest, sha256: hash(json(baseline))} : null});
  }
  const parent = recipe.parent ? snapshot(root, {...recipe.parent, excludeSnapshots: true}, retain) : null;
  const identities = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, {
    sha256: hash(Buffer.from(value.data, 'base64')), executable: value.executable,
  }]);
  return {
    schemaVersion: 1, parent: parent ? {key: parent.key, digest: parent.digest, sha256: hash(json(parent))} : null,
    edition: recipe.id, manifest: hash(json(recipe)), toolchain: toolsIdentity(),
    components, files: Object.fromEntries(identities),
  };
}
