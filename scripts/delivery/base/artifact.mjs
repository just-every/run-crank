import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { deploymentSpec } from './spec.mjs';
import { assetsIgnore, candidateRoot, checkedPath, collectFiles, comparePaths, moduleName, outputLocation, relativePath } from './paths.mjs';
import { MAX_ARTIFACT_MANIFEST_BYTES, MODULE_TYPES, moduleType, validatePayloadBounds, writePayloads } from './payloads.mjs';

const excludedModule = name => /(?:^|\/)wrangler\.json$/i.test(name) || /\.map$/i.test(name);
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Produce untrusted schema-2 bytes. The workflow independently attests them. */
export async function produceArtifact({ root = process.cwd(), output = 'delivery-artifact/rer-worker-artifact.json', specInputs, workerDirectory = 'dist/server', assetsDirectory = 'dist/client', mainModule = 'index.js', additionalModules = [] } = {}) {
  root = await candidateRoot(root);
  moduleName(mainModule);
  relativePath(workerDirectory, 'worker directory');
  relativePath(assetsDirectory, 'assets directory');
  if (!Array.isArray(additionalModules)) throw new Error('additionalModules must be an array');
  const destination = await outputLocation(root, output);
  if ([workerDirectory, assetsDirectory].some(input => overlaps(input, destination.relativeDirectory))) throw new Error('Artifact output must be separate from build inputs');
  const modules = (await collectFiles(root, workerDirectory)).filter(file => !excludedModule(file.name)).map(file => ({ ...file, name: moduleName(file.name), type: moduleType(file.name) }));
  const ignored = assetsIgnore(await readFile(join(root, assetsDirectory, '.assetsignore'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }));
  const assets = (await collectFiles(root, assetsDirectory)).filter(file => !ignored(file.name));
  for (const entry of additionalModules) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['name', 'type', 'path'].includes(key)) || typeof entry.name !== 'string' || typeof entry.path !== 'string' || !MODULE_TYPES.has(entry.type)) throw new Error('Invalid additional module: declare name, type and path');
    moduleName(entry.name);
    if (excludedModule(entry.name) || excludedModule(entry.path)) throw new Error('Wrangler configuration and source maps are not deployable modules');
    if (overlaps(entry.path, destination.relativeDirectory)) throw new Error('Additional module must be separate from artifact output');
    const path = await checkedPath(root, entry.path);
    modules.push({ name: entry.name, type: entry.type, path: entry.path, size: (await lstat(path)).size });
  }
  modules.sort((a, b) => comparePaths(a.name, b.name));
  if (new Set(modules.map(file => file.name)).size !== modules.length) throw new Error('Duplicate module name');
  if (!modules.some(file => file.name === mainModule)) throw new Error('Artifact entry module is not declared');
  validatePayloadBounds([...modules, ...assets]);
  const spec = await deploymentSpec(root, specInputs);
  // Recheck freshness after spec generation, before acquiring the destination.
  await outputLocation(root, output);
  await mkdir(destination.directory, { recursive: true });
  await checkedPath(root, destination.relativeDirectory, 'directory');
  const stage = await mkdtemp(join(destination.directory, '.packaging-'));
  try {
    const payloads = await writePayloads(root, stage, modules, assets);
    const manifest = Buffer.from(`${JSON.stringify({ schema: 2, deploymentSpec: spec, mainModule, ...payloads })}\n`);
    if (manifest.length > MAX_ARTIFACT_MANIFEST_BYTES) throw new Error('Artifact manifest exceeds size limit');
    const entries = await readdir(destination.directory);
    if (entries.length !== 1 || entries[0] !== basename(stage)) throw new Error('Artifact output directory changed while packaging');
    await rename(join(stage, 'payload'), join(destination.directory, 'payload'));
    await writeFile(destination.manifest, manifest, { flag: 'wx', mode: 0o600 });
  } finally { await rm(stage, { recursive: true, force: true }); }
  return destination.manifest;
}
