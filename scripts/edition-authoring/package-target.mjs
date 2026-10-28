import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as modules from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

let runtimeConditions, nodeResolve, temporary;
const scopes = new Map();
if (typeof modules.registerHooks === 'function') {
  const captured = {};
  let phase = 'import';
  const hook = modules.registerHooks({resolve(specifier, context, next) {
    if (specifier === 'node:fs' && context.parentURL === import.meta.url) {
      captured[phase] = new Set(context.conditions);
      if (phase === 'import') nodeResolve = next;
    }
    return next(specifier, context);
  }});
  try {
    await import('node:fs');
    phase = 'require';
    modules.createRequire(import.meta.url)('node:fs');
  } finally { hook.deregister(); }
  if (!captured.import || !captured.require || !nodeResolve) throw Error('Cannot determine Node package resolution.');
  runtimeConditions = captured;
}
function conditions(kind, types) {
  if (!runtimeConditions) throw Error('Use the pinned Node runtime before refreshing local package imports.');
  const selected = new Set(runtimeConditions[kind]);
  if (!types && selected.has('types')) throw Error('The types condition cannot satisfy runtime imports; remove it from Node options.');
  if (types) selected.add('types');
  return [...selected];
}
function scope(text) {
  if (scopes.has(text)) return scopes.get(text);
  if (!temporary) {
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rer-package-scopes-')));
    process.once('exit', () => fs.rmSync(temporary, {recursive: true, force: true}));
  }
  const root = path.join(temporary, String(scopes.size));
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'package.json'), text);
  const item = {root, parent: pathToFileURL(path.join(root, 'entry.mjs')).href, results: new Map()};
  scopes.set(text, item);
  return item;
}
function selectedTarget(text, specifier, kind, types) {
  const active = conditions(kind, types), item = scope(text), key = JSON.stringify([specifier, kind, types]);
  if (item.results.has(key)) return item.results.get(key);
  // Only metadata is materialized. Node selects and validates the package target;
  // actual file satisfaction is checked against the immutable/virtual tree below.
  let result, url;
  try {
    url = nodeResolve(specifier, {parentURL: item.parent, conditions: active, importAttributes: {}}).url;
  } catch (error) {
    // Node's import.meta.resolve also exposes a selected missing file's URL.
    // Presence is evaluated against the virtual tree rather than this metadata scope.
    if (['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error.code) && error.url) url = error.url;
    else if (error.code === 'ERR_MODULE_NOT_FOUND') result = {external: true, value: 'external package'};
    else if (['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_PACKAGE_IMPORT_NOT_DEFINED', 'ERR_INVALID_PACKAGE_TARGET', 'ERR_INVALID_PACKAGE_CONFIG', 'ERR_INVALID_MODULE_SPECIFIER'].includes(error.code)) result = {};
    else throw error;
  }
  if (url?.startsWith('file:')) {
    const relative = path.relative(item.root, fileURLToPath(url));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Package target escapes its package scope.');
    result = {relative: relative.split(path.sep).join('/')};
  } else if (url) result = {external: true, value: url};
  item.results.set(key, result);
  return result;
}

// Node owns condition order, null/array targets, patterns and target validation.
// This only supplies the nearest package scope from the virtual source tree.
export function packageTarget(tree, source, specifier, {kind, types, package: state = {}}) {
  if (!tree.read || /^[a-z][a-z\d+.-]*:/i.test(specifier) || specifier.startsWith('/')) return;
  let directory = path.posix.dirname(source);
  while (true) {
    const manifest = path.posix.join(directory, 'package.json');
    if (tree.has(manifest)) {
      const text = tree.read(manifest), data = JSON.parse(text);
      const privateImport = specifier.startsWith('#') && Object.hasOwn(data, 'imports');
      const self = typeof data.name === 'string' && (specifier === data.name || specifier.startsWith(data.name + '/')) && data.exports != null;
      if (!privateImport && !self) return;
      state.managed = true; state.manifest = manifest; state.type = data.type;
      const selected = selectedTarget(text, specifier, kind, types);
      Object.assign(state, selected);
      if (selected.relative !== undefined) state.target = path.posix.join(directory, selected.relative);
      return state.target;
    }
    if (directory === '.') return;
    directory = path.posix.dirname(directory);
  }
}
