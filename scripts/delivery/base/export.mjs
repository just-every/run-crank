import {mkdir, readFile, readdir, writeFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {candidateRoot, outputLocation} from './paths.mjs';
import {packagingConfig} from './package.mjs';
import {loadSetupManifest} from './setup-manifest.mjs';

/** Vendor the dependency-free Base runtime and explicit seed policy, never tests or evidence. */
export async function exportProducer({root = process.cwd(), config, output = 'scripts/delivery/base'} = {}) {
  const {setup} = packagingConfig(config);
  root = await candidateRoot(root);
  await loadSetupManifest(root, setup, config.artifact.specInputs?.mail);
  const destination = await outputLocation(root, `${output}/packaging.json`);
  const source = fileURLToPath(new URL('.', import.meta.url));
  const files = (await readdir(source)).filter(name => name.endsWith('.mjs')).sort();
  const generators = (await readdir(join(source,'generators'))).filter(name => name.endsWith('.mjs')).sort();
  const schemaSource = fileURLToPath(new URL('../../schema/', import.meta.url));
  const schemaFiles = ['SETUP.schema.json','json-schema.mjs','setup-validation.mjs','dependencies.mjs'];
  await mkdir(destination.directory, {recursive:true});
  try {
    for (const name of [...files, ...generators.map(name => `generators/${name}`)]) {
      if (name.startsWith('generators/')) await mkdir(join(destination.directory,'generators'), {recursive:true});
      let bytes = await readFile(join(source,name));
      if (name === 'setup-manifest.mjs') {
        const portable = bytes.toString('utf8')
          .replace("from '../../schema/setup-validation.mjs'", "from './schema/setup-validation.mjs'")
          .replace("new URL('../../schema/SETUP.schema.json', import.meta.url)", "new URL('./schema/SETUP.schema.json', import.meta.url)");
        bytes = Buffer.from(portable, 'utf8');
      }
      await writeFile(join(destination.directory,name), bytes, {flag:'wx'});
    }
    await mkdir(join(destination.directory,'schema'), {recursive:true});
    for (const name of schemaFiles) await writeFile(join(destination.directory,'schema',name), await readFile(join(schemaSource,name)), {flag:'wx'});
    await writeFile(destination.manifest, `${JSON.stringify(config,null,2)}\n`, {flag:'wx'});
  } catch (error) {
    await rm(destination.directory, {recursive:true,force:true});
    throw error;
  }
  return destination.directory;
}
