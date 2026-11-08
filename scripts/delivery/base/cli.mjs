#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {producePackage, produceSeedArtifact} from './package.mjs';
import {exportProducer} from './export.mjs';
import {candidateRoot, checkedPath} from './paths.mjs';

export async function packaging(args) {
  const [command, ...flags] = args;
  if (!['package','artifact','export'].includes(command)) throw Error('Expected package, artifact or export');
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    if (!['--root','--config','--output'].includes(flag) || !flags[index+1] || flags[index+1].startsWith('--') || Object.hasOwn(options, flag.slice(2))) throw Error('Invalid packaging arguments');
    options[flag.slice(2)] = flags[index+1];
  }
  options.root = await candidateRoot(options.root ?? process.cwd());
  options.config = JSON.parse(await readFile(await checkedPath(options.root, options.config ?? 'rer-packaging.json'), 'utf8'));
  return ({package:producePackage, artifact:produceSeedArtifact, export:exportProducer})[command](options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packaging(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    // Source configuration and child errors may contain credential values.
    console.error(error.code === 'mail_sender_conflict' ? error.message : 'Packaging failed; check source policy and bounded build inputs.');
    process.exitCode = 1;
  });
}
