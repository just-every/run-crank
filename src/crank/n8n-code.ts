type Node = { type?: unknown; typeVersion?: unknown; parameters?: unknown }
export interface CompiledN8nCode {
  source: string
  mode: 'runOnceForAllItems' | 'runOnceForEachItem'
  input: 'items'
  output: 'items'
  source_type: 'code'
}

const refuse = (): never => { throw Error('N8N_CODE_RUNTIME_API_REQUIRES_NATIVE_CONVERSION') }

/** Conservative source review; the isolated executor remains the security boundary.
 * Tokens in comments and strings also cause refusal rather than hiding runtime access. */
function inspect(source: string, each: boolean) {
  if (/\b(?:import|export|require|process|global|globalThis|window|self|module|exports|eval|Function|AsyncFunction|WebAssembly|fetch|XMLHttpRequest|WebSocket|EventSource|Request|Response|navigator|Deno|Bun|Buffer|console|helpers|getNodeParameter|getWorkflowStaticData|getBinaryData|setBinaryData|getBinaryDataAsync|setBinaryDataAsync|DateTime|luxon|jmespath|binary|pairedItem|pairedItemMatching|this|constructor|__proto__|prototype)\b/.test(source)) refuse()
  if (/\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\})/.test(source)) refuse()
  for (const match of source.matchAll(/\$(?:[A-Za-z_$][\w$]*)?/g)) {
    if (match[0] === '$' && source[match.index! + 1] === '{') continue
    if (match[0] !== '$input' && !(each && match[0] === '$json')) refuse()
    if (match[0] !== '$input') continue
    const tail = source.slice(match.index! + match[0].length)
    const access = /^\s*\.\s*(all|first|last|item)\b/.exec(tail)
    if (!access) return refuse()
    if (each && access[1] !== 'item') refuse()
    if (access[1] !== 'item' && !/^\s*\(\s*\)/.test(tail.slice(access[0].length))) refuse()
  }
}

/** Generate data only: original JavaScript is compiled and invoked later inside
 * the explicitly reviewed isolated executor, never in the import process. */
export function compileN8nCode(node: Node): CompiledN8nCode {
  if (node.type !== 'n8n-nodes-base.code' || ![1, 2].includes(node.typeVersion as number)) throw Error('N8N_CODE_NODE_REQUIRES_NATIVE_CONVERSION')
  const parameters = node.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw Error('N8N_CODE_PARAMETERS_REQUIRED')
  const p = parameters as Record<string, unknown>
  if (Object.keys(p).some(key => !['mode', 'language', 'jsCode'].includes(key)) || (p.language !== undefined && p.language !== 'javaScript')) throw Error('N8N_CODE_SETTINGS_REQUIRE_NATIVE_CONVERSION')
  const mode = p.mode ?? 'runOnceForAllItems'
  if (mode !== 'runOnceForAllItems' && mode !== 'runOnceForEachItem') throw Error('N8N_CODE_MODE_UNSUPPORTED')
  if (typeof p.jsCode !== 'string' || !p.jsCode.trim() || p.jsCode.length > 65536 || p.jsCode.startsWith('=')) throw Error('N8N_CODE_SOURCE_INVALID')
  const each = mode === 'runOnceForEachItem'
  inspect(p.jsCode, each)
  const source = `export default async function(input) {
  const fail = code => { throw new Error(code) };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const json = (value, seen = new Set(), depth = 0) => {
    if (depth > 100) fail('N8N_CODE_JSON_DEPTH');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || seen.has(value)) fail('N8N_CODE_JSON_VALUE_INVALID');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('N8N_CODE_JSON_VALUE_INVALID');
    if (Object.getOwnPropertySymbols(value).length) fail('N8N_CODE_JSON_VALUE_INVALID');
    seen.add(value);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !own(descriptor, 'value')) fail('N8N_CODE_JSON_VALUE_INVALID');
      json(descriptor.value, seen, depth + 1);
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length) fail('N8N_CODE_JSON_VALUE_INVALID');
    seen.delete(value);
  };
  const item = value => {
    if (!object(value)) fail('N8N_CODE_ITEM_OBJECT_REQUIRED');
    if (own(value, 'binary')) fail('N8N_CODE_BINARY_REQUIRES_FILE_CONVERSION');
    if (Object.keys(value).some(key => key !== 'json')) fail('N8N_CODE_ITEM_METADATA_REQUIRES_CONVERSION');
    if (!own(value, 'json') || !object(value.json)) fail('N8N_CODE_ITEM_JSON_OBJECT_REQUIRED');
    json(value.json);
    return value;
  };
  if (!object(input) || !Array.isArray(input.items)) fail('N8N_CODE_ITEMS_INPUT_REQUIRED');
  input.items.forEach(item);
  const original = JSON.stringify(input.items);
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const execute = new AsyncFunction('$input', '$json', ${JSON.stringify(p.jsCode + '\n')});
  const normalize = (value, each) => {
    if (value === null) return [];
    if (!object(value) && !Array.isArray(value)) fail('N8N_CODE_ITEM_OUTPUT_REQUIRED');
    if (each && Array.isArray(value)) fail('N8N_CODE_EACH_ITEM_OUTPUT_REQUIRED');
    if (object(value) && own(value, 'binary')) fail('N8N_CODE_BINARY_REQUIRES_FILE_CONVERSION');
    let items;
    if (!Array.isArray(value)) items = each ? [value] : own(value, 'json') ? [value] : [{json:value}];
    else items = value;
    if (items.some(value => !object(value))) fail('N8N_CODE_ITEM_OBJECT_REQUIRED');
    if (items.some(value => own(value, 'binary'))) fail('N8N_CODE_BINARY_REQUIRES_FILE_CONVERSION');
    const wrapped = items.filter(value => own(value, 'json')).length;
    if (wrapped && wrapped !== items.length) fail('N8N_CODE_ITEM_FORMAT_INCONSISTENT');
    if (!wrapped) items = items.map(value => ({json:value}));
    return items.map(item);
  };
  const run = async (items, index) => {
    const api = Object.create(null);
    Object.defineProperty(api, 'item', {get() {
      if (!items.length) fail('N8N_CODE_INPUT_DATA_MISSING');
      return items[index];
    }});
    for (const method of ['all','first','last']) Object.defineProperty(api, method, {value(...args) {
      if (${each}) fail('N8N_CODE_METHOD_REQUIRES_ALL_ITEMS_MODE');
      if (!items.length) fail('N8N_CODE_INPUT_DATA_MISSING');
      if (method !== 'all' && args.length) fail('N8N_CODE_INPUT_METHOD_ARGUMENTS_UNSUPPORTED');
      return method === 'all' ? items : method === 'first' ? items[0] : items[items.length - 1];
    }});
    const $input = new Proxy(api, {get(target, key) {
      if (!own(target, key)) fail('N8N_CODE_RUNTIME_API_REQUIRES_NATIVE_CONVERSION');
      return target[key];
    }});
    return normalize(await execute($input, ${each} ? items[index].json : undefined), ${each});
  };
  if (!${each}) return {items:await run(JSON.parse(original), 0)};
  const output = [];
  for (let index = 0; index < input.items.length; index++) output.push(...await run(JSON.parse(original), index));
  return {items:output};
}`
  if (source.length > 65536) throw Error('N8N_CODE_WRAPPER_SOURCE_LIMIT')
  return { source, mode, input: 'items', output: 'items', source_type: 'code' }
}
