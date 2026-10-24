import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {checkedPath, relativePath} from './paths.mjs';
import {keys} from './bindings.mjs';
import {parseSetupManifestBytes, validateSetupManifest} from './schema/setup-validation.mjs';
import {validateMailSetup} from './mail.mjs';

const setupSchemaUrl = new URL('./schema/SETUP.schema.json', import.meta.url);
const outputPath = 'rer-setup.json';

export function setupSelection(value) {
  if (value === undefined) return undefined;
  keys(value, ['manifestFile'], 'setup manifest selection');
  if (typeof value.manifestFile !== 'string' || !/\.json$/i.test(value.manifestFile)) {
    throw new Error('setup must select one root-relative JSON manifestFile');
  }
  relativePath(value.manifestFile, 'setup manifest');
  return {manifestFile: value.manifestFile};
}

/** Read the selected source bytes, reject ambiguity, and emit canonical sibling bytes. */
export async function loadSetupManifest(root, selection, mail) {
  if (selection === undefined) return null;
  const file = await checkedPath(root, selection.manifestFile);
  const inputBytes = await readFile(file);
  const manifest = parseSetupManifestBytes(inputBytes);
  const schema = JSON.parse(await readFile(setupSchemaUrl, 'utf8'));
  const errors = validateSetupManifest(schema, manifest);
  if (errors.length) throw new Error(`Invalid setup manifest: ${errors.join('; ')}`);
  validateMailSetup(mail, manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (selection.manifestFile === outputPath && !inputBytes.equals(bytes)) throw new Error('rer-setup.json must use canonical bytes: JSON.stringify(manifest, null, 2) plus a newline.');
  return {manifest, path: outputPath, bytes, sha256: createHash('sha256').update(bytes).digest('hex')};
}
