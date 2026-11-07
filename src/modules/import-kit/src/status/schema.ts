import importersSchemaJson from '../../schema/importers.schema.json' with { type: 'json' };
import receiptSchemaJson from '../../schema/importer-verification-receipt.schema.json' with { type: 'json' };
import { canonicalReceiptJson as canonicalJson } from '../receipt/encoding.ts';
import type { ImporterValidationIssue } from './types.ts';

interface JsonSchema {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  minItems?: number;
  minProperties?: number;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  format?: string;
  [key: string]: unknown;
}

const importersSchema = importersSchemaJson as unknown as JsonSchema;
const receiptSchema = receiptSchemaJson as unknown as JsonSchema;

export function validateStatusDocumentSchema(document: unknown): ImporterValidationIssue[] {
  if (!isJsonValue(document)) {
    return [{ code: 'DOCUMENT_NOT_JSON', path: '$', message: 'Importer status must be JSON data.' }];
  }
  return schemaIssues(document, importersSchema, importersSchema, '$');
}

export function validateReceiptDocumentSchema(document: unknown, path: string): ImporterValidationIssue[] {
  if (!isJsonValue(document)) {
    return [{ code: 'RECEIPT_NOT_JSON', path, message: 'Verification receipt must be JSON data.' }];
  }
  return schemaIssues(document, receiptSchema, receiptSchema, path);
}

function schemaIssues(value: unknown, schema: JsonSchema, root: JsonSchema, path: string): ImporterValidationIssue[] {
  if (typeof schema.$ref === 'string') {
    const target = resolveSchemaReference(root, schema.$ref);
    if (!target) return [{ code: 'INVALID_SCHEMA_REFERENCE', path, message: `Schema reference ${schema.$ref} does not resolve.` }];
    return schemaIssues(value, target, root, path);
  }

  if (schema.oneOf) {
    const matching = schema.oneOf.filter((branch) => schemaIssues(value, branch, root, path).length === 0).length;
    return matching === 1
      ? []
      : [{ code: 'SCHEMA_ONE_OF', path, message: matching === 0 ? 'Value does not match any allowed schema branch.' : 'Value matches more than one schema branch.' }];
  }

  const issues: ImporterValidationIssue[] = [];
  if (schema.type && !matchesType(value, schema.type)) {
    return [{ code: 'SCHEMA_TYPE', path, message: `Expected ${schema.type}.` }];
  }
  if (Object.hasOwn(schema, 'const') && !sameJsonValue(value, schema.const)) {
    issues.push({ code: 'SCHEMA_CONST', path, message: `Expected the constant ${JSON.stringify(schema.const)}.` });
  }
  if (schema.enum && !schema.enum.some((allowed) => sameJsonValue(value, allowed))) {
    issues.push({ code: 'SCHEMA_ENUM', path, message: 'Value is not one of the allowed values.' });
  }

  if (typeof value === 'string') {
    const length = codePointLength(value);
    if (schema.minLength !== undefined && value.trim().length === 0) {
      issues.push({ code: 'SCHEMA_BLANK_STRING', path, message: 'A non-empty string cannot contain only whitespace.' });
    }
    if (schema.minLength !== undefined && length < schema.minLength) {
      issues.push({ code: 'SCHEMA_MIN_LENGTH', path, message: `String must contain at least ${schema.minLength} character(s).` });
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      issues.push({ code: 'SCHEMA_MAX_LENGTH', path, message: `String must contain no more than ${schema.maxLength} character(s).` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      issues.push({ code: 'SCHEMA_PATTERN', path, message: 'String does not match the required pattern.' });
    }
    if (schema.format === 'date-time' && !isDateTime(value)) {
      issues.push({ code: 'SCHEMA_FORMAT', path, message: 'Expected an ISO 8601 date-time with a timezone.' });
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    issues.push({ code: 'SCHEMA_MINIMUM', path, message: `Number must be at least ${schema.minimum}.` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ code: 'SCHEMA_MIN_ITEMS', path, message: `Array must contain at least ${schema.minItems} item(s).` });
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        issues.push(...schemaIssues(value[index], schema.items, root, `${path}[${index}]`));
      }
    }
  }

  if (isPlainObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        issues.push({ code: 'SCHEMA_REQUIRED', path: `${path}.${required}`, message: 'Required property is missing.' });
      }
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      issues.push({ code: 'SCHEMA_MIN_PROPERTIES', path, message: `Object must contain at least ${schema.minProperties} property/properties.` });
    }
    for (const [key, propertyValue] of Object.entries(value)) {
      // Own members only: `constructor` or `__proto__` must not resolve to Object.prototype.
      const propertySchema = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (propertySchema) {
        issues.push(...schemaIssues(propertyValue, propertySchema, root, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        issues.push({ code: 'SCHEMA_ADDITIONAL_PROPERTY', path: `${path}.${key}`, message: 'Unknown property is not allowed.' });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        issues.push(...schemaIssues(propertyValue, schema.additionalProperties, root, `${path}.${key}`));
      }
    }
  }

  return issues;
}

/** Array.from(value).length without building the array: a surrogate pair counts once, a lone surrogate once. */
function codePointLength(value: string): number {
  let length = value.length;
  for (let index = 0; index + 1 < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { length -= 1; index += 1; }
    }
  }
  return length;
}

function resolveSchemaReference(root: JsonSchema, reference: string): JsonSchema | undefined {
  if (!reference.startsWith('#/')) return undefined;
  let value: unknown = root;
  for (const token of reference.slice(2).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!isPlainObject(value) || !Object.hasOwn(value, token)) return undefined;
    value = value[token];
  }
  return isPlainObject(value) ? value as JsonSchema : undefined;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function isJsonValue(value: unknown, active = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (active.has(value)) return false;
    active.add(value);
    const valid = value.every((item) => isJsonValue(item, active));
    active.delete(value);
    return valid;
  }
  if (isPlainObject(value)) {
    if (active.has(value)) return false;
    active.add(value);
    const valid = Object.values(value).every((item) => isJsonValue(item, active));
    active.delete(value);
    return valid;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isDateTime(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetWithinRange = offsetHour < 14 || (offsetHour === 14 && offsetMinute === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]!
    && hour <= 23 && minute <= 59 && second <= 59 && offsetMinute <= 59 && offsetWithinRange;
}
