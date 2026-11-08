import { validateSubflowDefinition, validateSubflowValue } from './subflow-definition.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error('Recipe: ' + message); };
/** Community provenance is unverified. Installation imports only an inert pure definition. */
export function validatePureRecipe(value) {
  if (!object(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536 ||
      Object.keys(value).some(key => !['format','name','release','definition','connector_requirements','samples'].includes(key))) fail('declare a pure recipe within 64 KiB');
  if (value.format !== 'crank.pure-recipe.v1' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || /[\u0000-\u001f\u007f]/.test(value.name) ||
      typeof value.release !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,59}$/.test(value.release)) fail('name the recipe format and explicit release');
  if (!Array.isArray(value.connector_requirements) || value.connector_requirements.length) fail('pure recipes require no connectors; provider recipes are not supported');
  validateSubflowDefinition(value.definition);
  if (value.definition.kind === 'native') fail('native graph recipes need separate review and are not pure recipe samples');
  const mappings = (item, depth = 0) => {
    if (depth > 32) fail('mapping nests too deeply');
    if (Array.isArray(item)) return item.forEach(value => mappings(value, depth + 1));
    if (!object(item) || Object.hasOwn(item, '$literal')) return;
    if (Object.hasOwn(item, '$fn')) fail('declare pure operations as steps; nested function mappings are not supported');
    Object.values(item).forEach(value => mappings(value, depth + 1));
  };
  for (const step of value.definition.steps) mappings(step.input);
  mappings(value.definition.result);
  if (!Array.isArray(value.samples) || !value.samples.length || value.samples.length > 3) fail('include one to three synthetic sample tests');
  for (const sample of value.samples) {
    if (!object(sample) || Object.keys(sample).some(key => !['input','output'].includes(key))) fail('sample tests declare input and output only');
    validateSubflowValue(value.definition.inputs, sample.input, 'sample input');
    validateSubflowValue(value.definition.outputs, sample.output, 'sample output');
  }
}
