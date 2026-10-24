import { lstat, readdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const privateName = /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.?netrc|_netrc|\.pypirc|\.git-credentials|\.gitconfig|\.dockercfg|(?:owner|providers)\.json|credentials(?:\.(?:json|ini|toml|yaml|yml))?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const privateDirectories = new Set(['.git', '.seed', '.ssh', '.aws', '.wrangler', 'node_modules']);
const reserved = new Set(['release-provenance.json', 'rer-broker-entry.js']);
export const comparePaths = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Strict portable relative paths, checked before opening any input. */
export function relativePath(value, label = 'path') {
  if (typeof value !== 'string' || !value || value.length > 512 || /^[a-z]:/i.test(value) || /[\x00-\x1f\x7f"\\]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid ${label}: expected a root-relative portable path`);
  if (value.split('/').some(part => privateName.test(part) || privateDirectories.has(part.toLowerCase()) || reserved.has(part.toLowerCase()))) throw new Error(`Private or reserved ${label} refused: ${value}`);
  return value;
}

export function moduleName(value) {
  relativePath(value, 'module name');
  if (value.split('/')[0].toLowerCase() === 'payload') throw new Error('Reserved payload module name');
  return value;
}

export async function candidateRoot(root) {
  if (typeof root !== 'string' || !root) throw new Error('Candidate root is required');
  const path = resolve(root);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Candidate root must be a real directory');
  return realpath(path);
}

/** lstat every component, including ancestor directories, without following links. */
export async function checkedPath(root, value, kind = 'file') {
  relativePath(value, 'input path');
  let path = root;
  const parts = value.split('/');
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Artifact symlink refused');
    if (i < parts.length - 1 || kind === 'directory') {
      if (!stat.isDirectory()) throw new Error('Artifact input must be a directory');
    } else if (!stat.isFile()) throw new Error('Artifact input must be a regular file');
  }
  return path;
}

/** Traverse names only; privacy and symlink checks happen before reading bytes. */
// Wrangler's .assetsignore in an assets folder: gitignore-style lines naming
// files that are never assets. The file itself is never one either.
export function assetsIgnore(text = '') {
  const rules = String(text).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
    const negate = line.startsWith('!'), body = negate ? line.slice(1) : line, directory = body.endsWith('/'), pattern = body.replace(/\/+$/, '');
    const glob = pattern.replace(/^\//, '').split('/').map(part => part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')).join('/');
    return { negate, test: new RegExp(`^${pattern.includes('/') ? '' : '(?:.*/)?'}${glob}${directory ? '/.*' : '(?:/.*)?'}$`) };
  });
  return path => path === '.assetsignore' || rules.reduce((ignored, rule) => rule.test.test(path) ? !rule.negate : ignored, false);
}
export async function collectFiles(root, directory) {
  await checkedPath(root, directory, 'directory');
  const files = [];
  async function visit(relative) {
    const path = await checkedPath(root, relative, 'directory');
    for (const name of (await readdir(path)).sort(comparePaths)) {
      const child = `${relative}/${name}`;
      relativePath(child, 'build entry');
      const stat = await lstat(join(root, child));
      if (stat.isSymbolicLink()) throw new Error('Artifact symlink refused');
      if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) files.push({ name: child.slice(directory.length + 1), path: child, size: stat.size });
      else throw new Error('Artifact input must be a regular file');
    }
  }
  await visit(directory);
  return files.sort((a, b) => comparePaths(a.name, b.name));
}

export async function outputLocation(root, output) {
  relativePath(output, 'artifact output');
  const parts = output.split('/');
  const filename = parts.pop();
  if (!parts.length || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(filename) || filename.includes('..') || parts[0].toLowerCase() === 'payload') throw new Error('Artifact output must be <package-directory>/<filename>.json');
  let path = root;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Artifact output must use real directories');
    if (i === parts.length - 1 && (await readdir(path)).length) throw new Error('Artifact output directory must be fresh and empty');
  }
  return { directory: join(root, ...parts), manifest: join(root, output), relativeDirectory: parts.join('/') };
}
