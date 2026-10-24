#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {release, verifyReceipt} from './release.mjs';
import {changes, extract, compare} from './updates.mjs';
import {manifest, VERSION} from './manifest.mjs';
import {snapshot, source, merge} from './sources.mjs';
import {options, recordCopy, refreshCopies, verifyCopies} from './base-copies.mjs';
import {hash, json, git, tracked, writeTree, fresh} from './files.mjs';

const root = process.cwd();
function toolsIdentity() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const names = fs.readdirSync(dir).filter(p => p.endsWith('.mjs') && !p.endsWith('.test.mjs')).sort();
  const bytes = names.map(p => p + '\0' + fs.readFileSync(path.join(dir, p), 'utf8')).join('\0');
  return {id: 'runeditrun/edition-authoring', version: VERSION, sha256: hash(bytes)};
}
function includes(files, selected) {
  return Object.keys(files).some(p => p === selected || p.startsWith(selected + '/'));
}
function resolve(retain = false, diagnostics = false) {
  const recipe = manifest(root);
  const files = tracked(root, diagnostics);
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
function check() {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'sources.lock.json'), 'utf8'));
  const actual = resolve();
  if (json(expected) !== json(actual)) throw Error('Stale lock or source/tool integrity mismatch; run changes to inspect intentional edits before lock');
  return actual;
}
function materialize(destination) {
  const output = fresh(destination, root);
  const recipe = manifest(root);
  const files = tracked(root);
  for (const component of recipe.components) {
    if (component.source.kind === 'git') merge(files, component.source.destination, source(root, component.source, true));
  }
  fs.mkdirSync(output, {recursive: true});
  writeTree(output, files);
  return {output, development: true};
}
function promote(id) {
  const recipe = manifest(root);
  const component = recipe.components.find(c => c.id === id);
  if (!component || component.source.kind !== 'git') throw Error('Select a Git component');
  const selected = component.source;
  const destinationExisted = fs.existsSync(path.join(root, selected.destination));
  const files = source(root, selected, true);
  snapshot(root, selected, true);
  merge(tracked(root), selected.destination, files);
  const retained = Object.fromEntries(Object.entries(files).map(([name, value]) => [selected.destination + '/' + name, value]));
  writeTree(root, retained);
  component.source = {
    kind: 'local', paths: destinationExisted ? Object.keys(retained) : [selected.destination],
    origin: {
      repository: selected.repository, ...(selected.projection ? {projection: selected.projection} : {revision: selected.revision}), path: selected.path || '.',
      ...(selected.paths ? {paths: selected.paths} : {}),
    },
  };
  fs.writeFileSync(path.join(root, 'edition.json'), json(recipe));
  return {promoted: id, destination: selected.destination, next: 'git add the retained source and recipe, then lock and commit'};
}

try {
  const args = process.argv.slice(2);
  // Package scripts may forward their argument separator after the command.
  if (args[1] === '--') args.splice(1, 1);
  const [command, argument, candidate, current] = args;
  let result;
  if (command === 'inspect') result = manifest(root);
  else if (command === 'lock') {
    result = resolve(true);
    fs.writeFileSync(path.join(root, 'sources.lock.json'), json(result));
  } else if (command === 'check') result = {ok: true, ...check()};
  else if (command === 'materialize' && argument) result = materialize(argument);
  else if (command === 'promote' && argument) result = promote(argument);
  else if (command === 'release' && argument) result = release(root, argument, check);
  else if (command === 'receipt' && argument) result = verifyReceipt(root, argument, check);
  else if (command === 'changes') result = changes(JSON.parse(fs.readFileSync(path.join(root, 'sources.lock.json'))), resolve(false, true));
  else if (command === 'extract' && argument && candidate) result = extract(root, argument, candidate);
  else if (command === 'compare' && argument && candidate) result = compare(root, argument, candidate, current);
  else if (command === 'verify-base') {
    result = verifyCopies(root, options(args.slice(1), 0));
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'record-base') result = recordCopy(root, options(args.slice(1), 3));
  else if (command === 'refresh-base') result = refreshCopies(root, options(args.slice(1), 1));
  else throw Error('Usage: cli.mjs inspect|lock|check|receipt <sidecar-json>|changes|extract <id|parent> <new-output>|compare <id|parent> <candidate-checkout> [current-parent-checkout]|materialize <new-output>|promote <id>|release <new-local-git-repository>|verify-base [--record <file>] [--base <checkout>] [--offline]|record-base <path> <origin-path> <revision> [--record <file>] [--base <checkout>]|refresh-base <revision> [--record <file>] [--base <checkout>]');
  console.log(json(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
