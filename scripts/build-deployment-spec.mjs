import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {deploymentSpec} from './delivery/base/spec.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(new URL('../packaging.json', import.meta.url), 'utf8'));
const output = new URL('../management/integration/deployment-spec.json', import.meta.url);
const bytes = JSON.stringify(await deploymentSpec(root, config.artifact.specInputs), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== bytes) throw Error('Deployment specification is stale; build the application and run pnpm delivery:spec.');
  console.log('Deployment specification matches the real build and source policy.');
} else {
  await mkdir(new URL('./', output), {recursive: true});
  await writeFile(output, bytes);
  console.log('Wrote management/integration/deployment-spec.json');
}
