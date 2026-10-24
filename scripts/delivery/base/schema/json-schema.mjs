/** Browser comparison is restricted to the JSON values carried by a setup manifest. */
function isDeepStrictEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) !== Array.isArray(right)) return false;
  const names = Object.keys(left);
  return names.length === Object.keys(right).length
    && names.every(name => Object.hasOwn(right, name) && isDeepStrictEqual(left[name], right[name]));
}

// Validates data against the subset of JSON Schema 2020-12 the seed schemas use.
//
// `checkSchema` walks a whole schema — every subschema, including branches no
// document reaches — and throws on the first keyword this file does not enforce,
// so a schema can never claim a rule that is not checked. Run it once before
// validating anything. `validate` repeats the check for the subschemas a given
// document reaches, which is all it can see on its own.
//
// A keyword added to SUPPORTED must be enforced in `validate`, and, if its value
// holds subschemas, listed in SUBSCHEMAS so the walk descends into it. A type
// added to TYPES must be one `typeOf` can return.

const SUPPORTED = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description',
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties',
  'propertyNames', 'items', 'minItems', 'maxItems', 'minLength', 'pattern', 'format',
  'allOf', 'if', 'then', 'not', 'uniqueItems'
]);

// The supported keywords whose value holds subschemas, and how they hold them:
// 'schema' one, 'map' one per property name, 'list' one per array entry.
const SUBSCHEMAS = {
  $defs: 'map',
  properties: 'map',
  additionalProperties: 'schema',
  propertyNames: 'schema',
  items: 'schema',
  allOf: 'list',
  if: 'schema',
  then: 'schema',
  not: 'schema'
};

const SUPPORTED_FORMATS = new Set(['date']);

// `type` is one name or a union of them: `["string", "null"]` is how a field that
// is a string or explicitly nothing — an edition that does not exist yet — says so.
// The string keywords apply to the string member; nothing constrains null.
const TYPES = new Set(['null', 'boolean', 'integer', 'number', 'string', 'array', 'object']);

const typeNames = (type) => (Array.isArray(type) ? type : [type]);

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

const matchesType = (expected, actual) =>
  typeNames(expected).some((name) => name === actual || (name === 'number' && actual === 'integer'));

const isCalendarDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y)
    && date.getUTCMonth() === Number(m) - 1
    && date.getUTCDate() === Number(d);
};

const resolveRef = (ref, root) => {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref "${ref}"`);
  let node = root;
  for (const segment of ref.slice(2).split('/')) {
    node = Object.hasOwn(node ?? {}, segment) ? node[segment] : undefined;
    if (node === undefined) throw new Error(`unresolvable $ref "${ref}"`);
  }
  return node;
};

// Throws on the first keyword or format this file does not enforce, anywhere in
// the schema — an unused $def and an absent property are walked like any other.
export function checkSchema(schema, path = '#') {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`expected a schema object at ${path}`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`unsupported schema keyword "${keyword}" at ${path}`);
  }
  if (Object.hasOwn(schema, 'format') && !SUPPORTED_FORMATS.has(schema.format)) {
    throw new Error(`unsupported format "${schema.format}" at ${path}`);
  }
  // A misspelled name inside a union would otherwise narrow the rule silently.
  for (const name of Object.hasOwn(schema, 'type') ? typeNames(schema.type) : []) {
    if (!TYPES.has(name)) throw new Error(`unsupported type "${name}" at ${path}`);
  }
  for (const [keyword, shape] of Object.entries(SUBSCHEMAS)) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    if (shape === 'map') {
      for (const name of Object.keys(value)) checkSchema(value[name], `${path}/${keyword}/${name}`);
    } else if (shape === 'list') {
      value.forEach((sub, index) => checkSchema(sub, `${path}/${keyword}/${index}`));
    } else if (typeof value !== 'boolean') {
      checkSchema(value, `${path}/${keyword}`);
    }
  }
  return schema;
}

// A readable label for a conditional branch: { change: { const: 'changed' } }
// becomes `when change is "changed"`.
const conditionLabel = (condition) => {
  const parts = Object.entries(condition.properties ?? {})
    .filter(([, sub]) => Object.hasOwn(sub, 'const'))
    .map(([name, sub]) => `${name} is ${JSON.stringify(sub.const)}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
};

export function validate(schema, data, { root = schema, path = '$', label = '' } = {}) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`unsupported schema keyword "${keyword}" at ${path}`);
  }
  if (schema.$ref) return validate(resolveRef(schema.$ref, root), data, { root, path, label });

  const errors = [];
  const fail = (message) => errors.push(`${path}${label}: ${message}`);
  const actual = typeOf(data);

  if (schema.type && !matchesType(schema.type, actual)) {
    fail(`expected ${typeNames(schema.type).join(' or ')}, got ${actual}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(data)) {
    fail(`${JSON.stringify(data)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (Object.hasOwn(schema, 'const') && data !== schema.const) {
    fail(`expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.not && validate(schema.not, data, { root, path }).length === 0) {
    fail('must not match excluded schema');
  }

  if (actual === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) fail(`must not be empty`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) {
      fail(`${JSON.stringify(data)} does not match ${schema.pattern}`);
    }
    if (Object.hasOwn(schema, 'format')) {
      if (!SUPPORTED_FORMATS.has(schema.format)) throw new Error(`unsupported format "${schema.format}" at ${path}`);
      if (!isCalendarDate(data)) fail(`${JSON.stringify(data)} is not a YYYY-MM-DD date`);
    }
  }

  // Object.hasOwn throughout: an inherited `toString` or a JSON `__proto__` key is
  // a property like any other and must meet the same rules.
  if (actual === 'object') {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(data, name)) fail(`missing required property "${name}"`);
    }
    for (const name of Object.keys(data)) {
      const value = data[name];
      const child = `${path}.${name}`;
      if (schema.propertyNames && validate(schema.propertyNames, name, { root, path: child }).length) {
        fail(`property name "${name}" does not match ${schema.propertyNames.pattern}`);
      }
      const sub = schema.properties && Object.hasOwn(schema.properties, name)
        ? schema.properties[name]
        : schema.additionalProperties;
      if (sub === undefined || sub === true) continue;
      if (sub === false) {
        fail(`unknown property "${name}"`);
        continue;
      }
      errors.push(...validate(sub, value, { root, path: child }));
    }
  }

  if (actual === 'array') {
    if (schema.uniqueItems === true && data.some((item, index) => data.slice(0, index).some((previous) => isDeepStrictEqual(item, previous)))) {
      fail('items must be unique');
    }
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      fail(`needs at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      fail(`needs at most ${schema.maxItems} item(s)`);
    }
    if (schema.items) {
      data.forEach((item, index) => {
        errors.push(...validate(schema.items, item, { root, path: `${path}[${index}]` }));
      });
    }
  }

  for (const branch of schema.allOf ?? []) {
    errors.push(...validate(branch, data, { root, path, label }));
  }
  if (schema.if) {
    const holds = validate(schema.if, data, { root, path }).length === 0;
    if (holds && schema.then) {
      errors.push(...validate(schema.then, data, { root, path, label: conditionLabel(schema.if) }));
    }
  }

  return errors;
}
