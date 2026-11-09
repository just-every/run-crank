// Package installation belongs to the edition. Optional source additions may
// not impose a new package, and retained source must refuse before any writes.
import fs from 'node:fs';
import path from 'node:path';
import {isBuiltin} from 'node:module';
import {dependencies, resolve} from './runtime-dependencies.mjs';

const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const version = (manifest, name) => sections.map(section => manifest[section]?.[name]).find(value => typeof value === 'string');
function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') ||
      /^[a-z][a-z\d+.-]*:/i.test(specifier) || isBuiltin(specifier)) return;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function checkModulePackages(root, modules, roots, tree) {
  const filename = path.join(root, 'package.json');
  const manifest = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
  const manifests = new Map(), packages = new Map(), missing = new Map();
  function baseVersion(source, name) {
    let directory = path.posix.dirname(source);
    while (true) {
      const file = path.posix.join(directory, 'package.json');
      if (tree.has(file)) {
        if (!manifests.has(file)) manifests.set(file, JSON.parse(tree.read(file)));
        const declared = version(manifests.get(file), name);
        if (declared) return declared;
      }
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
    // Shared foundation runtime lives outside the maintained app's package.
    const reference = 'default-seed/package.json';
    if (!tree.has(reference)) return;
    if (!manifests.has(reference)) manifests.set(reference, JSON.parse(tree.read(reference)));
    return version(manifests.get(reference), name);
  }
  for (const [target, module] of modules) for (const request of module.packageRequests ?? dependencies(module.bytes, module.source)) {
    const name = packageName(request.specifier);
    if (!name) continue;
    const scope = {};
    resolve(tree, module.source, request.specifier, {...request, package: scope});
    if (scope.managed && !scope.external) continue; // A local package self-reference.
    const declared = version(manifest, name), pinned = baseVersion(module.source, name);
    const key = JSON.stringify([name, declared, pinned]);
    if (!packages.has(key)) packages.set(key, {package: name, version: declared ?? null, baseVersion: pinned ?? null,
      conflict: Boolean(declared && pinned && declared !== pinned), files: []});
    packages.get(key).files.push(target);
    if (!declared) {
      if (!missing.has(target)) missing.set(target, new Map());
      missing.get(target).set(name, {package: name, baseVersion: pinned ?? null});
    }
  }
  const required = new Set();
  function retain(target) {
    if (required.has(target) || !modules.has(target)) return;
    required.add(target);
    for (const dependency of modules.get(target).dependencies) retain(dependency);
  }
  roots.forEach(retain);
  const refusals = [];
  for (const [target, items] of missing) if (required.has(target)) for (const item of items.values()) {
    refusals.push(`Cannot refresh module ${target}: package ${item.package} is not declared in the seed's package.json${item.baseVersion ? ` (Base uses ${item.baseVersion})` : ''}. This module is required by retained source.`);
  }
  if (refusals.length) throw Error([...refusals,
    "Review their adoption, declare and install all named dependencies at Base's listed versions with the seed's package manager, then repeat refresh-base; no files were refreshed.",
  ].join('\n'));
  // Withhold the whole connected optional addition, including its importers
  // and exclusive siblings, rather than leaving half of a feature behind.
  const neighbours = new Map([...modules.keys()].map(target => [target, new Set()]));
  for (const [target, module] of modules) for (const dependency of module.dependencies) if (modules.has(dependency)) {
    neighbours.get(target).add(dependency); neighbours.get(dependency).add(target);
  }
  const withheld = new Map();
  function hold(target, reason) {
    if (required.has(target) || withheld.has(target)) return;
    withheld.set(target, {...reason, path: target, originPath: modules.get(target).source, reason: 'undeclared-package'});
    for (const neighbour of neighbours.get(target)) hold(neighbour, reason);
  }
  for (const [target, items] of missing) hold(target, items.values().next().value);
  return {withheld, packageDependencies: [...packages.values()].map(item => ({...item, files: [...new Set(item.files)].sort()}))};
}
