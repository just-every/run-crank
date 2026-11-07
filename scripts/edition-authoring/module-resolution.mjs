import path from 'node:path';
import {packageTarget} from './package-target.mjs';
export const external = Symbol('external package target');
export function canonical(specifier, kind = 'import') {
  return kind !== 'require' && specifier?.startsWith('.') ? specifier.split(/[?#]/)[0] : specifier;
}

const declaration = name => /\.d\.[cm]?ts$/.test(name);
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

// Every import kind uses this resolver. Runtime JS follows Node's file/require
// rules; source TS also recognizes filenames produced by its compiler. An
// erased type edge is the only route that can resolve a declaration file.
// Package-name imports belong to the edition's package manager, not this graph.
export function resolve(tree, source, specifier, {types = false, kind = 'import', manifests = new Set(), package: packageState = {}} = {}) {
  types ||= declaration(source);
  const packaged = !specifier.startsWith('.');
  const packagePath = packaged && packageTarget(tree, source, specifier, {kind, types, package: packageState});
  if (packageState.external) return external;
  if (packaged && !packagePath) return;
  const relative = canonical(specifier, kind);
  if (kind !== 'require' && /%2f|%5c/i.test(relative)) throw Error(`Invalid encoded separator in module specifier ${specifier}`);
  const name = packaged ? packagePath : path.posix.normalize(path.posix.join(path.posix.dirname(source), kind === 'require' ? relative : decodeURIComponent(relative)));
  const sourceModule = /\.(?:[cm]?ts|[jt]sx)$/.test(source);
  const file = candidate => (types || !declaration(candidate)) && tree.has(candidate) ? candidate : undefined;
  if (!types && declaration(name)) return;
  const direct = file(name);
  if (direct) return direct;
  const extension = path.posix.extname(name);
  if (sourceModule || types) {
    const replacements = {'.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts']}[extension] ?? [];
    if (types) replacements.push(...({'.js': ['.d.ts'], '.mjs': ['.d.mts'], '.cjs': ['.d.cts']}[extension] ?? []));
    for (const replacement of replacements) {
      const found = file(name.slice(0, -extension.length) + replacement);
      if (found) return found;
    }
  }
  // Exports/imports targets are exact files; require's legacy directory and
  // extension searches do not apply to a package export target.
  if (packaged) return;
  if (sourceModule || types || kind === 'require') {
    const suffixes = sourceModule || types ? [...sourceExtensions, ...(types ? ['.d.ts', '.d.mts', '.d.cts'] : [])] : ['.js', '.json', '.node'];
    for (const suffix of suffixes) {
      const found = file(name + suffix);
      if (found) return found;
    }
    // Relative require-directory resolution consults main, never types/typings
    // or exports. Node only consults exports when resolving a package name.
    const manifest = name + '/package.json';
    if (kind === 'require' && tree.has(manifest) && tree.read) {
      const main = JSON.parse(tree.read(manifest)).main;
      if (typeof main === 'string') {
        const target = path.posix.join(name, main);
        if (!types && declaration(target) && tree.has(target)) return;
        for (const candidate of [target, ...['.js', '.json', '.node'].map(suffix => target + suffix), ...['.js', '.json', '.node'].map(suffix => target + '/index' + suffix)]) {
          const found = file(candidate);
          if (found) { manifests.add(manifest); return found; }
        }
      }
    }
    for (const suffix of suffixes) {
      const found = file(name + '/index' + suffix);
      if (found) return found;
    }
  }
}
