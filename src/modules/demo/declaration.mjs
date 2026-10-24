import { readFile } from 'node:fs/promises';
import { containedInput } from './input-path.mjs';
import { pathToFileURL } from 'node:url';

export async function demoRunDeclaration(declaration, { root, adapter, read } = {}) {
  if (declaration.runUrl !== undefined) return declaration;
  read ??= async path => JSON.parse(await readFile(await containedInput(root, path), 'utf8'));
  let bare = false;
  if (adapter === undefined) {
    let operations;
    try { operations = await read('OPERATIONS.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; bare = true; }
    if (operations?.seedContract) adapter = (await import(pathToFileURL(await containedInput(root, operations.seedContract.adapter)).href)).commandAdapter;
  }
  const path = adapter?.site?.declaration ?? (bare ? 'deploy-site.json' : undefined);
  if (!path) return declaration;
  let site;
  try { site = await read(path); }
  catch (error) { if (!bare || error.code !== 'ENOENT') throw error; }
  return site ? { ...declaration, runUrl: `https://${site.domain}/run` } : declaration;
}
