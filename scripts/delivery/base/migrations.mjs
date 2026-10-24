import {lstat, readFile, readdir, realpath} from 'node:fs/promises';
import {resolve, relative, isAbsolute, sep, join} from 'node:path';
import {createHash} from 'node:crypto';
import {array, keys, string, bindingPattern} from './bindings.mjs';
export const codeUnitOrder = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const privatePart = /^(?:\.git|\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.pypirc|release-provenance\.json)$/i;
/** Check each actual path component, including in-root symlinks. Never read through one. */
export async function sourcePath(root, input, {base = root, kind = 'file', optional = false} = {}) {
  if (typeof input !== 'string' || !input || /[\\\x00-\x1f\x7f]/.test(input)) throw Error('Invalid candidate source path');
  const rootPath = await realpath(root);
  let destination = resolve(base, input);
  // macOS /var and /tmp aliases (and an explicitly supplied root alias) refer
  // to the same candidate root. Normalize only that known root, not child links.
  const lexicalWithin = relative(resolve(root), destination);
  if (lexicalWithin && lexicalWithin !== '..' && !lexicalWithin.startsWith(`..${sep}`) && !isAbsolute(lexicalWithin)) destination = resolve(rootPath, lexicalWithin);
  const within = relative(rootPath, destination);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw Error('Input escapes candidate source or names its root');
  const parts = within.split(sep);
  if (parts.some(part => privatePart.test(part))) throw Error('Private candidate source path is forbidden');
  let path = rootPath;
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT' && optional) return null; throw error; }
    if (stat.isSymbolicLink()) throw Error('Candidate source symlink is forbidden');
    if (index < parts.length - 1 ? !stat.isDirectory() : kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw Error(`Candidate source must be a regular ${kind}`);
  }
  return path;
}
export function decodeUtf8(bytes, label) {
  // Preserve a UTF-8 BOM: it is part of both SQL text and its byte digest.
  try { return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes); }
  catch { throw Error(`Invalid UTF-8 ${label}`); }
}
export async function collectMigrations(root, directories, resources) {
  const result = [], identities = new Set();
  for (const directory of array(directories, 'migration directories')) {
    keys(directory, ['binding','path','prefix','optional'], 'migration directory');
    string(directory.binding, 'migration binding', bindingPattern);
    if (!resources.some(row => row.kind === 'd1' && row.binding === directory.binding)) throw Error(`Migration directory requires D1 binding: ${directory.binding}`);
    if (directory.optional !== undefined && typeof directory.optional !== 'boolean') throw Error('Invalid migration optional flag');
    const prefix = directory.prefix === undefined ? '' : directory.prefix;
    if (typeof prefix !== 'string' || !/^[\w.-]*$/.test(prefix)) throw Error('Invalid migration prefix');
    const path = await sourcePath(root, directory.path, {kind:'directory',optional:directory.optional === true});
    if (path === null) continue;
    for (const file of (await readdir(path, {withFileTypes:true})).sort((a,b) => codeUnitOrder(a.name,b.name))) {
      if (!file.name.endsWith('.sql')) continue;
      if (!file.isFile() || !/^[\w.-]+\.sql$/.test(file.name)) throw Error('Migration must be a regular SQL file');
      const name = prefix + file.name, identity = `${directory.binding}/${name}`;
      if (identities.has(identity)) throw Error(`Duplicate migration identity: ${identity}`);
      identities.add(identity);
      const filePath = await sourcePath(root, join(path, file.name));
      const bytes = await readFile(filePath);
      if (bytes.length > 10 * 1024 * 1024) throw Error('Migration exceeds supported limit');
      const sql = decodeUtf8(bytes, 'migration');
      result.push({binding:directory.binding,name,sha256:createHash('sha256').update(bytes).digest('hex'),sql});
    }
  }
  return result;
}
