#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {release, verifyReceipt} from './release.mjs';
import {changes, extract, compare} from './updates.mjs';
import {manifest} from './manifest.mjs';
import {snapshot, source, merge} from './sources.mjs';
import {options, adaptCopy, recordCopy, refreshCopies, verifyCopies} from './base-copies.mjs';
import {json, tracked, writeTree, fresh} from './files.mjs';

import {resolveSources} from './lock.mjs';
import {adoptEdition} from './adopt.mjs';

const root = process.cwd();
const resolve = (retain = false, diagnostics = false) => resolveSources(root, retain, diagnostics);
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
  if (command === 'adopt') result = adoptEdition(root);
  else if (command === 'inspect') result = manifest(root);
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
  else if (command === 'adapt-base') result = adaptCopy(root, options(args.slice(1), 1));
  else if (command === 'refresh-base') result = refreshCopies(root, options(args.slice(1), 1));
  else throw Error('Usage: cli.mjs adopt|inspect|lock|check|receipt <sidecar-json>|changes|extract <id|parent> <new-output>|compare <id|parent> <candidate-checkout> [current-parent-checkout]|materialize <new-output>|promote <id>|release <new-local-git-repository>|verify-base [--record <file>] [--base <checkout>] [--offline]|record-base <path> <origin-path> <revision>|--ref <revision> [--record <file>] [--base <checkout>|--base-archive <directory>|--from-api|--offline --base <checkout>]|adapt-base <file> [--record <file>]|refresh-base <revision>|--ref <revision> [--record <file>] [--base <checkout>|--base-archive <directory>]');
  console.log(json(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
