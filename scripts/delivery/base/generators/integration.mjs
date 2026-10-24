import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, writeFile, rm} from 'node:fs/promises';
import {dirname, isAbsolute, parse, relative, resolve, sep} from 'node:path';
import {object, publicPath, rejectPrivatePath, repository as repositoryName} from './validation.mjs';

async function realDirectory(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Integration directories must be real directories without symlinks');
  }
  return absolute;
}

function within(root, path) {
  const difference = relative(root, path);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference));
}

/** Export reviewed static-import source from committed Git blobs, never a checkout. */
export async function generateIntegrationBundle(input) {
  object(input, 'integration bundle', ['projectRoot', 'repository', 'revision', 'output', 'sourcePath']);
  const {projectRoot, revision, output, sourcePath = 'management/integration'} = input;
  const repository = repositoryName(input.repository);
  if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('An immutable lowercase 40-character Git commit is required');
  publicPath(sourcePath);
  if (typeof projectRoot !== 'string' || !projectRoot) throw new Error('projectRoot is required');
  if (typeof output !== 'string' || !output || output.includes('\\') || /[\x00-\x1f\x7f]/.test(output) || output.split('/').some(part => part === '.' || part === '..')) throw new Error('Unsafe integration output directory');
  const root = await realDirectory(projectRoot);
  const destination = resolve(output);
  const outputRelative = relative(parse(destination).root, destination).split(sep).join('/');
  // The output may be outside the project, but must not target private state.
  rejectPrivatePath(outputRelative);
  if (within(resolve(root, sourcePath), destination)) throw new Error('Output cannot be inside integration source');
  await realDirectory(dirname(destination));
  try {
    await lstat(destination);
    throw new Error('Integration output must be a fresh directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const git = args => execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  if (git(['rev-parse', '--show-toplevel']).toString().trim() !== root) throw new Error('projectRoot must be the Git repository root');
  if (git(['rev-parse', `${revision}^{commit}`]).toString().trim() !== revision) throw new Error('Revision must identify the exact commit');
  const tree = git(['rev-parse', `${revision}:${sourcePath}`]).toString().trim();
  if (git(['cat-file', '-t', tree]).toString().trim() !== 'tree') throw new Error('Integration sourcePath must be a committed directory');
  const entries = git(['ls-tree', '-rz', tree]).toString('utf8').split('\0').filter(Boolean);
  if (!entries.length) throw new Error('No committed integration files');
  const files = [], contents = new Map(), foldedPaths = new Map();
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error('Integration contains a symlink or unsupported Git entry');
    const path = publicPath(match[3]);
    if (path.toLowerCase() === 'adoption.json') throw new Error('adoption.json is reserved for the retained receipt');
    // Reject case-fold collisions even on case-sensitive author machines: the
    // resulting retained bundle must also be safe on case-insensitive systems.
    const parts = path.split('/');
    for (let count = 1; count <= parts.length; count += 1) {
      const prefix = parts.slice(0, count).join('/');
      const folded = prefix.toLowerCase();
      if (foldedPaths.has(folded) && (foldedPaths.get(folded) !== prefix || count === parts.length)) throw new Error('Duplicate integration path');
      foldedPaths.set(folded, prefix);
    }
    const bytes = git(['cat-file', 'blob', match[2]]);
    files.push({path, sourcePath: `${sourcePath}/${path}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length});
    contents.set(path, bytes);
  }
  // The service exporter uses localeCompare; retain its exact manifest order.
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {schema: 1, repository, revision, sourcePath, files};
  await mkdir(destination, {recursive: false});
  try {
    for (const [path, bytes] of contents) {
      await mkdir(dirname(resolve(destination, path)), {recursive: true});
      await writeFile(resolve(destination, path), bytes, {flag: 'wx'});
    }
    await writeFile(resolve(destination, 'adoption.json'), `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'});
  } catch (error) {
    // Only remove the fresh directory owned by this call, never caller content.
    await rm(destination, {recursive: true, force: true});
    throw error;
  }
  return manifest;
}
