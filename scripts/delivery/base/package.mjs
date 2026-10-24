import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {produceArtifact} from './artifact.mjs';
import {candidateRoot, checkedPath, outputLocation, relativePath} from './paths.mjs';
import {keys, string} from './bindings.mjs';
import {generateProjectDescriptor} from './generators/project.mjs';
import {generateManagedWorkflow} from './generators/managed.mjs';
import {loadSetupManifest, setupSelection} from './setup-manifest.mjs';
import {validateDeclarations} from './declarations.mjs';

export function packagingConfig(config) {
  keys(config, ['schema','project','managed','artifact','edition','setup'], 'packaging configuration');
  if (config.schema !== 1) throw Error('Packaging configuration schema must be 1');
  const project = generateProjectDescriptor(config.project);
  if (project.deployment.target !== 'cloudflare-workers') throw Error('Packaging requires the cloudflare-workers target');
  keys(config.artifact, ['specInputs','workerDirectory','assetsDirectory','mainModule','additionalModules'], 'artifact policy');
  validateDeclarations(config.artifact.specInputs ?? {});
  if (config.managed.artifactFile !== project.deployment.artifactFile) throw Error('Workflow and project artifact filenames must agree');
  const workflow = generateManagedWorkflow(config.managed);
  if ((config.managed.buildProfile ?? 'project') === 'project' && (config.managed.verificationProfiles ?? ['full','visual']).includes('visual')) throw Error('The trusted project workflow requires full verification');
  if (config.edition !== undefined) {
    keys(config.edition, ['manifestFile','componentId'], 'edition selection');
    relativePath(config.edition.manifestFile, 'edition manifest');
    string(config.edition.componentId, 'edition component');
  }
  return {project, workflow, setup: setupSelection(config.setup)};
}

export async function checkEdition(root, selection) {
  if (selection === undefined) return;
  const manifest = JSON.parse(await readFile(await checkedPath(root, selection.manifestFile), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.components)) throw Error('Expected edition authoring manifest schemaVersion 1');
  const matches = manifest.components.filter(component => component.id === selection.componentId);
  if (matches.length !== 1 || matches[0].role !== 'edition') throw Error('Select one declared edition component');
}

/** Single source policy produces all three files. Output is fresh, credential-free data. */
export async function producePackage({root = process.cwd(), config, output = 'rer-package'} = {}) {
  root = await candidateRoot(root);
  const {project, workflow, setup} = packagingConfig(config);
  await checkEdition(root, config.edition);
  const selectedSetup = await loadSetupManifest(root, setup, config.artifact.specInputs?.mail);
  const descriptor = selectedSetup
    ? {...project, setup: {path: selectedSetup.path, sha256: selectedSetup.sha256}}
    : project;
  relativePath(output, 'package output');
  const destination = await outputLocation(root, `${output}/rer-project.json`);
  await mkdir(destination.directory, {recursive:true});
  try {
    const artifact = await produceArtifact({...config.artifact, root, output:`${output}/delivery-artifact/${project.deployment.artifactFile}`});
    await mkdir(join(destination.directory, '.github/workflows'), {recursive:true});
    await writeFile(destination.manifest, `${JSON.stringify(descriptor, null, 2)}\n`, {flag:'wx'});
    if (selectedSetup) await writeFile(join(destination.directory, selectedSetup.path), selectedSetup.bytes, {flag:'wx'});
    await writeFile(join(destination.directory, '.github/workflows/rer-managed.yml'), workflow, {flag:'wx'});
    const result = {artifact, project:destination.manifest, workflow:join(destination.directory, '.github/workflows/rer-managed.yml')};
    if (selectedSetup) result.setup = join(destination.directory, selectedSetup.path);
    return result;
  } catch (error) {
    // The destination was checked empty; clean only this call's package.
    await rm(destination.directory, {recursive:true, force:true});
    throw error;
  }
}

/** Seed-owned thin callers use exactly the same artifact implementation. */
export async function produceSeedArtifact({root = process.cwd(), config, output} = {}) {
  root = await candidateRoot(root);
  const {project, setup} = packagingConfig(config);
  await checkEdition(root, config.edition);
  await loadSetupManifest(root, setup, config.artifact.specInputs?.mail);
  return produceArtifact({...config.artifact, root, output:output ?? `delivery-artifact/${project.deployment.artifactFile}`});
}
