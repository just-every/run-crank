import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {sourcePath, decodeUtf8} from './migrations.mjs';

/** Explicit packaging policy wins; a declared adapter path never implies email hint support. */
export async function seedSignIn(root, spec) {
  if (spec.surfaces?.app?.signIn !== undefined) return;
  const operations = await sourcePath(root, 'OPERATIONS.json', {optional:true});
  if (operations === null) return;
  const descriptor = JSON.parse(decodeUtf8(await readFile(operations), 'operations descriptor'));
  if (descriptor.seedContract === undefined) return;
  const file = await sourcePath(root, descriptor.seedContract.adapter);
  const {commandAdapter} = await import(pathToFileURL(file).href);
  if (commandAdapter?.signInPath === undefined) return;
  spec.surfaces ??= {app:{path:'/'}};
  spec.surfaces.app.signIn = {path:commandAdapter.signInPath, loginHint:false};
}
