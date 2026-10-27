const types = ['string', 'number', 'boolean', 'object', 'array', 'null'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error('Subflow: ' + message); };
const named = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value);
export const PURE_SUBFLOW_FUNCTIONS = ['text.trim', 'text.case', 'text.replace', 'text.strip_html'];
export function validateSubflowDefinition(value) {
  if (!object(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536 || Object.keys(value).some(key => !['kind', 'inputs', 'outputs', 'steps', 'result'].includes(key))) fail('declare only inputs, outputs, steps and result, within 64 KiB');
  for (const key of ['inputs', 'outputs']) {
    const schema = value[key];
    if (!object(schema) || Object.keys(schema).length > 30 || Object.entries(schema).some(([name, type]) => !named(name) || !types.includes(type))) fail(key + ' must name up to 30 typed fields');
  }
  if (value.kind !== undefined && value.kind !== 'native') fail('kind must be native or omitted');
  if (value.kind === 'native') { validateNativeSteps(value.steps, value.result); if (!object(value.result)) fail('result must map declared outputs'); return; }
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

/** The same capability boundary is checked on creation, execution and staged restore. */
function validateNativeSteps(steps, result) {
  const ids = new Set(); let expanded = 0;
  const fields = {
    map: ['input'], transform: ['fn','input'], filter: ['when'],
    delay: ['mode','input','timezone','calendar','if_past','on_expired','expires_after'],
    loop: ['input','max_items','concurrency','order','empty','item_errors','steps','result'],
    paths: ['mode','branches','fallback','always','on_type_mismatch'],
  };
  const mapping = (value, depth = 0) => {
    if (depth > 32) fail('mapping nests too deeply');
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, '$fn')) fail('native graphs declare transformations as steps');
    Object.values(value).forEach(item => mapping(item, depth + 1));
  };
  const walk = (list, depth = 1, expansion = 1) => {
    if (!Array.isArray(list) || !list.length || depth > 4) fail('native graphs need nonempty steps within four levels');
    for (const step of list) {
      if (!object(step) || !named(step.id) || ids.has(step.id) || !Object.hasOwn(fields,step.type)) fail('native steps need distinct ids and account-free types');
      ids.add(step.id); expanded += expansion;
      if (ids.size > 20 || expanded > 2000) fail('native graph exceeds its bounded step budget');
      if (Object.keys(step).some(key => !['id','type','name','on_error',...fields[step.type]].includes(key))) fail('native graphs carry no connections, credentials, code or authority');
      mapping(step.input); mapping(step.result); mapping(step.when);
      if (step.type === 'transform' && !PURE_SUBFLOW_FUNCTIONS.includes(step.fn)) fail('native transformations use supported bounded text functions');
      if (step.type === 'transform' && step.fn === 'text.replace' && step.input?.pattern !== undefined && step.input.pattern !== false) fail('only literal replacement is supported');
      if (step.type === 'delay' && !['for','until'].includes(step.mode)) fail('native delays use for or until; shared queues are not supported');
      if (step.type === 'loop') {
        if (!Number.isInteger(step.max_items) || step.max_items < 1 || step.max_items > 50) fail('native loops declare at most 50 items');
        walk(step.steps,depth+1,expansion*step.max_items);
      }
      if (step.type === 'paths') {
        if (!Array.isArray(step.branches) || !step.branches.length || step.branches.length > 10) fail('native paths need one to ten branches');
        for (const branch of step.branches) {
          if (!object(branch) || Object.keys(branch).some(key => !['id','name','when','steps'].includes(key))) fail('invalid native path');
          mapping(branch.when); walk(branch.steps,depth+1,expansion);
        }
        for (const key of ['fallback','always']) if (step[key]) {
          if (!object(step[key]) || Object.keys(step[key]).some(key => key !== 'steps')) fail('invalid native fallback');
          walk(step[key].steps,depth+1,expansion);
        }
      }
    }
  };
  mapping(result);
  walk(steps);
}
