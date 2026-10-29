import { isDeepStrictEqual } from 'node:util';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const types = { null: value => value === null, object, array: Array.isArray, string: value => typeof value === 'string', boolean: value => typeof value === 'boolean', number: value => typeof value === 'number' && Number.isFinite(value), integer: Number.isSafeInteger };
const pointer = (root, ref) => ref.split('/').slice(1).reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);

/** JSON Schema assertions used by tool output declarations; returns diagnostic paths. */
export function schemaErrors(schema, value, root = schema, path = '$', depth = 0) {
 if (depth > 100) return [`${path}: schema recursion limit`];
 if (schema === true) return [];
 if (schema === false) return [`${path}: forbidden`];
 if (!object(schema)) return [`${path}: schema must be an object or boolean`];
 const errors = [], add = (ok, detail) => { if (!ok) errors.push(`${path}: ${detail}`); };
 const check = (sub, item = value, at = path) => schemaErrors(sub, item, root, at, depth + 1);
 if ('$ref' in schema) {
  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#')) add(false, 'only local schema references are supported');
  else { const target = schema.$ref === '#' ? root : pointer(root, schema.$ref.slice(1)); if (target === undefined) add(false, `unresolved ${schema.$ref}`); else errors.push(...check(target)); }
 }
 if (schema.type !== undefined) add((Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => Object.hasOwn(types, type) && types[type](value)), `expected ${JSON.stringify(schema.type)}`);
 if (schema.const !== undefined) add(isDeepStrictEqual(value, schema.const), 'const mismatch');
 if (schema.enum) add(schema.enum.some(item => isDeepStrictEqual(item, value)), 'enum mismatch');
 if (schema.allOf) for (const sub of schema.allOf) errors.push(...check(sub));
 if (schema.anyOf) add(schema.anyOf.some(sub => !check(sub).length), 'no anyOf alternative matched');
 if (schema.oneOf) add(schema.oneOf.filter(sub => !check(sub).length).length === 1, 'expected one matching oneOf alternative');
 if (schema.not) add(check(schema.not).length > 0, 'not schema matched');
 if (schema.if) errors.push(...check(!check(schema.if).length ? schema.then ?? true : schema.else ?? true));
 if (typeof value === 'number') {
  if (schema.minimum !== undefined) add(value >= schema.minimum, 'below minimum');
  if (schema.maximum !== undefined) add(value <= schema.maximum, 'above maximum');
  if (typeof schema.exclusiveMinimum === 'number') add(value > schema.exclusiveMinimum, 'below exclusiveMinimum');
  if (typeof schema.exclusiveMaximum === 'number') add(value < schema.exclusiveMaximum, 'above exclusiveMaximum');
  if (schema.multipleOf !== undefined) add(Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) < Number.EPSILON * 8, 'multipleOf mismatch');
 }
 if (typeof value === 'string') {
  if (schema.minLength !== undefined) add([...value].length >= schema.minLength, 'below minLength');
  if (schema.maxLength !== undefined) add([...value].length <= schema.maxLength, 'above maxLength');
  if (schema.pattern !== undefined) { try { add(new RegExp(schema.pattern, 'u').test(value), 'pattern mismatch'); } catch { add(false, 'invalid schema pattern'); } }
  if (schema.format === 'date-time') add(/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), 'invalid date-time');
  if (schema.format === 'email') add(/^[^\s@]+@[^\s@]+$/.test(value), 'invalid email');
  if (schema.format === 'uuid') add(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value), 'invalid uuid');
  if (schema.format === 'uri') { try { new URL(value); } catch { add(false, 'invalid URI'); } }
 }
 if (Array.isArray(value)) {
  if (schema.minItems !== undefined) add(value.length >= schema.minItems, 'below minItems');
  if (schema.maxItems !== undefined) add(value.length <= schema.maxItems, 'above maxItems');
  if (schema.uniqueItems) add(value.every((item, i) => value.slice(0, i).every(other => !isDeepStrictEqual(item, other))), 'duplicate array items');
  const tuple = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : []);
  for (let i = 0; i < value.length; i++) {
   const itemSchema = tuple[i] ?? (Array.isArray(schema.items) ? schema.additionalItems : schema.items);
   if (itemSchema !== undefined) errors.push(...check(itemSchema, value[i], `${path}[${i}]`));
  }
  if (schema.contains) { const count = value.filter(item => !check(schema.contains, item).length).length; add(count >= (schema.minContains ?? 1) && count <= (schema.maxContains ?? Infinity), 'contains count mismatch'); }
 }
 if (object(value)) {
  const keys = Object.keys(value);
  if (schema.minProperties !== undefined) add(keys.length >= schema.minProperties, 'below minProperties');
  if (schema.maxProperties !== undefined) add(keys.length <= schema.maxProperties, 'above maxProperties');
  for (const key of schema.required ?? []) add(Object.hasOwn(value, key), `missing required ${key}`);
  for (const key of keys) {
   const at = `${path}.${key}`, matches = [];
   if (Object.hasOwn(schema.properties ?? {}, key)) matches.push(schema.properties[key]);
   for (const [pattern, sub] of Object.entries(schema.patternProperties ?? {})) { try { if (new RegExp(pattern, 'u').test(key)) matches.push(sub); } catch { add(false, 'invalid patternProperties pattern'); } }
   if (!matches.length && schema.additionalProperties !== undefined) matches.push(schema.additionalProperties);
   for (const sub of matches) errors.push(...check(sub, value[key], at));
   if (schema.propertyNames) errors.push(...check(schema.propertyNames, key, at));
   for (const dependency of schema.dependentRequired?.[key] ?? []) add(Object.hasOwn(value, dependency), `${key} requires ${dependency}`);
   if (schema.dependentSchemas?.[key]) errors.push(...check(schema.dependentSchemas[key]));
  }
 }
 return errors;
}
