import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parse } from '../../../edition-authoring/vendor/babel-parser/babel-parser/index.mjs';

export class NetworkAdapterError extends Error {}
const invalid = message => new NetworkAdapterError(`Agent conformance network: ${message}`);
const contained = (root, path) => {
 const name = relative(root, path);
 return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
};

export function validateNetworkAdapter(config) {
 if (!config || typeof config !== 'object' || Array.isArray(config) ||
  Object.keys(config).some(key => !['module', 'origins'].includes(key)) ||
  typeof config.module !== 'string' || !config.module || isAbsolute(config.module) || config.module.includes('\\') ||
  !Array.isArray(config.origins) || !config.origins.length) {
  throw invalid('verification.network must declare a seed-relative module and a nonempty origins array.');
 }
 const origins = new Set();
 for (const origin of config.origins) {
  let url;
  try { url = new URL(origin); } catch { /* Report only the declaration field, never a credential-bearing URL. */ }
  if (typeof origin !== 'string' || !url || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
   throw invalid('verification.network.origins must contain exact HTTP(S) origins without credentials, paths, queries or fragments.');
  }
  if (origins.has(origin)) throw invalid('verification.network.origins must not repeat an origin.');
  origins.add(origin);
 }
 return { module: config.module, origins };
}

function imports(source) {
 let ast;
 try { ast = parse(source, { sourceType: 'module', createImportExpressions: true }); }
 catch { throw invalid('the adapter or a relative helper is not valid ES module JavaScript.'); }
 const pending = [ast], result = [];
 while (pending.length) {
  const node = pending.pop();
  let specifier;
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
   if (node.source.type !== 'StringLiteral') throw invalid('adapter imports must use literal relative module paths.');
   specifier = node.source.value;
  }
  if (specifier !== undefined) {
   if (!(specifier.startsWith('./') || specifier.startsWith('../')) || specifier.includes('\\') || specifier.includes('?') || specifier.includes('#')) {
    throw invalid('adapter imports must be relative JavaScript modules; packages, Node APIs and runtime built-ins are unavailable.');
   }
   result.push(specifier);
  }
  for (const value of Object.values(node)) {
   if (Array.isArray(value)) pending.push(...value.filter(item => item && typeof item.type === 'string'));
   else if (value && typeof value.type === 'string') pending.push(value);
  }
 }
 return result;
}

// Supply only snapshotted, checked module bytes to workerd. It has no filesystem
// loader, so an unresolved or computed import cannot read another host file.
export async function networkAdapterModules(root, entry) {
 let directory;
 try { directory = await realpath(root); }
 catch { throw invalid('the seed root is unreadable.'); }
 const pending = [resolve(directory, entry)], seen = new Set(), modules = [];
 while (pending.length) {
  const path = pending.shift();
  if (seen.has(path)) continue;
  if (!contained(directory, path) || !['.mjs', '.js'].includes(extname(path))) {
   throw invalid('the adapter and every helper must be .mjs or .js files contained in the seed root.');
  }
  let canonical, contents;
  try {
   canonical = await realpath(path);
   if (!contained(directory, canonical)) throw invalid('an adapter module symlink escapes the seed root.');
   if (!(await stat(canonical)).isFile()) throw invalid('an adapter module is not a regular file.');
   contents = await readFile(canonical, 'utf8');
  } catch (error) {
   if (error instanceof NetworkAdapterError) throw error;
   throw invalid('the declared adapter or a relative helper cannot be read. Use explicit relative .mjs or .js file paths.');
  }
  seen.add(path);
  modules.push({ type: 'ESModule', path, contents });
  pending.push(...imports(contents).map(specifier => resolve(dirname(path), specifier)));
 }
 return { root: directory, modules };
}
