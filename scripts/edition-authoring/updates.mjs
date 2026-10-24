import fs from 'node:fs';
import path from 'node:path';
import {manifest} from './manifest.mjs';
import {snapshot} from './sources.mjs';
import {parentFiles, parentIdentities} from './parent-comparison.mjs';
import {hash, json, git, tracked, fresh, writeTree} from './files.mjs';

function diff(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(name => json(before[name]) !== json(after[name]))
    .map(name => ({path: name, change: !(name in before) ? 'added' : !(name in after) ? 'removed' : 'modified', before: before[name] ?? null, after: after[name] ?? null}));
}
export function changes(before, after) {
  return {
    files: diff(before.files, after.files),
    metadata: diff(Object.fromEntries(Object.entries(before).filter(([k]) => k !== 'files')),
      Object.fromEntries(Object.entries(after).filter(([k]) => k !== 'files'))),
    meaning: 'Origins are comparison baselines; changing an origin does not assert adoption or local byte equality.',
  };
}
function baseline(root, id) {
  const recipe = manifest(root);
  const component = recipe.components.find(c => c.id === id);
  const ref = id === 'parent' ? recipe.parent && {...recipe.parent, excludeSnapshots: true}
    : component?.source.kind === 'git' ? component.source : component?.source.origin;
  if (!ref) throw Error('Selected component has no comparison baseline');
  const saved = snapshot(root, ref);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'sources.lock.json')));
  const expected = id === 'parent' ? lock.parent : lock.components.find(c => c.id === id)?.baseline;
  if (!expected || saved.key !== expected.key || saved.digest !== expected.digest || hash(json(saved)) !== expected.sha256) {
    throw Error('Baseline differs from lock; inspect selection before extracting or comparing');
  }
  return {component, ref, saved};
}
export function extract(root, id, destination) {
  const output = fresh(destination, root);
  const {saved} = baseline(root, id);
  writeTree(output, saved.files);
  return {output, origin: saved.origin, digest: saved.digest, files: Object.keys(saved.files).length};
}
function identities(files) {
  return Object.fromEntries(Object.entries(files).map(([name, file]) => [name,
    {sha256: hash(Buffer.from(file.data, 'base64')), executable: file.executable}]));
}
// The most specific mapping owns a local file; one origin file may have several
// local copies, and each copy is compared with that origin file on its own.
function owner(mappings, name) {
  let found = null;
  for (const mapping of mappings) {
    if (name !== mapping.path && !name.startsWith(mapping.path + '/')) continue;
    if (found?.path === mapping.path && found.originPath !== mapping.originPath) throw Error(`Ambiguous comparison mappings for ${mapping.path}`);
    if (!found || mapping.path.length > found.path.length) found = mapping;
  }
  return found;
}
function mappedChanges(mappings, before, editionFiles) {
  const result = [];
  for (const [name, file] of Object.entries(editionFiles)) {
    const mapping = owner(mappings, name);
    if (!mapping) continue;
    const target = mapping.originPath + name.slice(mapping.path.length);
    const after = identities({[name]: file})[name];
    if (json(before[target]) !== json(after)) result.push({path: target, localPath: name, change: before[target] ? 'modified' : 'added', before: before[target] ?? null, after});
  }
  for (const mapping of mappings) for (const [target, identity] of Object.entries(before)) {
    if (target !== mapping.originPath && !target.startsWith(mapping.originPath + '/')) continue;
    const name = mapping.path + target.slice(mapping.originPath.length);
    if (!(name in editionFiles) && owner(mappings, name) === mapping) result.push({path: target, localPath: name, change: 'removed', before: identity, after: null});
  }
  return result.sort((a, b) => a.path.localeCompare(b.path) || a.localPath.localeCompare(b.localPath));
}
export function compare(root, id, candidate, currentRoot = root) {
  const {component, ref, saved} = baseline(root, id);
  const repository = fs.realpathSync(candidate);
  if (fs.realpathSync(git(repository, 'rev-parse', '--show-toplevel')) !== repository) throw Error('Candidate must be a Git repository root');
  if (git(repository, 'status', '--porcelain', '--untracked-files=all')) throw Error('Candidate must be clean and committed');
  // Incoming source is the candidate's own Git source; it never inherits a projection identity.
  const incoming = snapshot(root, {...ref, projection: undefined, repository, revision: git(repository, 'rev-parse', 'HEAD')});
  if (!component) {
    const normalize = parentIdentities(root, saved);
    const before = normalize(saved.files), current = normalize(parentFiles(currentRoot));
    return {component: 'parent', baseline: {origin: saved.origin, digest: saved.digest},
      incoming: {origin: incoming.origin, digest: incoming.digest},
      upstreamChanges: diff(before, normalize(incoming.files)),
      localChanges: diff(before, current), currentFiles: current, mappings: null,
      meaning: 'Whole-parent comparison reads independent incoming Git source and current tracked source. Only exact planned projection identities and planned omissions are normalized; all other bytes, modes, additions and removals remain visible. This does not judge compatibility, owner intent, or adoption.',
    };
  }
  if (currentRoot !== root) throw Error('An independent current checkout is supported only for parent comparison');
  const selected = component.source;
  if (selected.workspace) throw Error('Promote or commit workspace source before comparing immutable selections');
  const editionFiles = tracked(root);
  const mappings = selected.kind === 'git' ? [] : selected.mappings || [];
  const owned = selected.kind === 'local' ? Object.fromEntries(Object.entries(editionFiles)
    .filter(([name]) => selected.paths.some(p => name === p || name.startsWith(p + '/')))) : saved.files;
  const before = identities(saved.files);
  return {component: id, baseline: {origin: saved.origin, digest: saved.digest},
    incoming: {origin: incoming.origin, digest: incoming.digest},
    upstreamChanges: diff(before, identities(incoming.files)),
    // Never guess correspondence for dispersed or deeply rewritten local source.
    localChanges: selected.kind === 'git' ? [] : mappings.length ? mappedChanges(mappings, before, editionFiles) : null,
    currentFiles: identities(owned), mappings,
    meaning: 'Current source may intentionally differ. Local comparison uses explicit mappings only; each local copy is compared with its own origin file. This does not judge compatibility, owner intent, or adoption.',
  };
}
