const types = ['string', 'number', 'boolean', 'object', 'array', 'null'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error('Subflow: ' + message); };
const named = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value);
export const PURE_SUBFLOW_FUNCTIONS = ['text.trim', 'text.case', 'text.replace', 'text.strip_html'];
export function validateSubflowDefinition(value) {
  if (!object(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536 || Object.keys(value).some(key => !['inputs', 'outputs', 'steps', 'result'].includes(key))) fail('declare only inputs, outputs, steps and result, within 64 KiB');
  for (const key of ['inputs', 'outputs']) {
    const schema = value[key];
    if (!object(schema) || Object.keys(schema).length > 30 || Object.entries(schema).some(([name, type]) => !named(name) || !types.includes(type))) fail(key + ' must name up to 30 typed fields');
  }
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 20) fail('declare 1 to 20 pure transformations');
  const ids = new Set();
  for (const step of value.steps) {
    if (!object(step) || !named(step.id) || ids.has(step.id) || !PURE_SUBFLOW_FUNCTIONS.includes(step.fn) || !object(step.input) || Object.keys(step).some(key => !['id', 'fn', 'input'].includes(key))) fail('steps need distinct ids, a supported pure function and mapped input; connections, code, grants and actions are not supported');
    ids.add(step.id);
  }
  if (!object(value.result)) fail('result must map the declared output fields');
}
export function validateSubflowValue(schema, value, label) {
  if (!object(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536 || Object.keys(value).some(key => !Object.hasOwn(schema, key))) fail(label + ' must contain only the declared fields within 64 KiB');
  for (const [name, type] of Object.entries(schema)) {
    const item = value[name];
    const valid = Object.hasOwn(value, name) && (type === 'null' ? item === null : type === 'array' ? Array.isArray(item) : type === 'object' ? object(item) : type === 'number' ? typeof item === 'number' && Number.isFinite(item) : typeof item === type);
    if (!valid) fail(label + '.' + name + ' must be ' + type);
  }
}
