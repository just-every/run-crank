import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// The CLI and standalone Vite copy share checkout-path resolution. The CLI
// supplies its public diagnostics; other callers retain filesystem errors.
export async function containedInput(root, path, { optional = false, privateFile = false, refuse = message => new Error(message), missing = (_message, error) => error } = {}) {
 if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || part === '')) throw refuse('Path must be a contained checkout path without traversal.');
 const checkout = await realpath(root), destination = resolve(checkout, path), parts = relative(checkout, destination).split(sep);
 let current = checkout;
 for (let i = 0; i < parts.length; i++) {
  current = resolve(current, parts[i]);
  let status; try { status = await lstat(current); } catch (error) { if (error.code === 'ENOENT' && optional) return destination; if (error.code === 'ENOENT') throw missing(`Missing input file: ${path}. See the project operating documentation.`, error); throw error; }
  if (status.isSymbolicLink()) throw refuse(`Symlink refused at ${path}; preserve it and resolve placement first.`);
  if (i < parts.length - 1 && !status.isDirectory()) throw refuse(`Unsafe path ancestor for ${path}.`);
  if (privateFile && i === parts.length - 1 && (!status.isFile() || status.nlink !== 1 || (status.mode & 0o077) !== 0 || (process.getuid && status.uid !== process.getuid()))) throw refuse(`Input must be an owned regular private file (0600): ${path}.`);
 }
 return destination;
}
