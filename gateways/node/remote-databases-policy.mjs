import { createRequire } from 'node:module';
import { GatewayError, fail, isObject, MAX_OUTPUT_BYTES } from './errors.mjs';

const require = createRequire(import.meta.url);
const dialects = { 'postgres-query': 'postgresql', 'mysql-query': 'mysql', 'sqlserver-query': 'transactsql' };
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const mutation = new Set(['insert', 'update', 'delete', 'replace', 'merge', 'create', 'alter', 'drop', 'truncate', 'call', 'exec', 'execute', 'set', 'transaction', 'grant', 'revoke', 'copy', 'load', 'use']);

export function validateRemoteDatabase(op) {
  if (!isObject(op) || !Object.hasOwn(dialects, op.type) || !isObject(op.connection) ||
      op.read_only_credentials !== true || !Number.isInteger(op.maxRows) || op.maxRows < 1 || op.maxRows > 1000 ||
      typeof op.query !== 'string' || op.query.length > 16384 || !/^\s*(SELECT|WITH)\b/i.test(op.query) || op.query.includes('/*')) {
    fail('operation_refused', 'Remote database operation requires a bounded SELECT, declared read-only credentials and explicit connection.');
  }
  const connection = op.connection, server = op.type === 'sqlserver-query';
  const allowed = [server ? 'server' : 'host', 'port', 'user', 'password', 'database', server ? 'options' : 'ssl'];
  if (Object.keys(connection).some(key => !allowed.includes(key)) || !nonempty(connection[server ? 'server' : 'host']) ||
      !nonempty(connection.user) || !nonempty(connection.database) || typeof connection.password !== 'string' || !connection.password || connection.password.length > 4096 ||
      !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) {
    fail('operation_refused', 'Remote database connection must explicitly configure host, port, database and local credentials.');
  }
  const local=['127.0.0.1','localhost','::1'].includes(connection[server?'server':'host']);
  if(!local && (server ? connection.options?.encrypt===false || connection.options?.trustServerCertificate===true : !connection.ssl || isObject(connection.ssl) && connection.ssl.rejectUnauthorized===false)) {
    fail('operation_refused','Remote database credentials require verified TLS outside loopback.');
  }
  if ((server && connection.options !== undefined && !isObject(connection.options)) ||
      (!server && connection.ssl !== undefined && typeof connection.ssl !== 'boolean' && !isObject(connection.ssl))) {
    fail('operation_refused', 'Remote database TLS configuration must use explicit driver options.');
  }
  if (!isObject(op.parameters) || Object.keys(op.parameters).length > 32) fail('operation_refused', 'Remote database parameters require local type declarations.');
  for (const [name, schema] of Object.entries(op.parameters)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || !isObject(schema) || !['string', 'integer', 'number', 'boolean'].includes(schema.type) ||
        (schema.optional !== undefined && typeof schema.optional !== 'boolean') ||
        (schema.maxLength !== undefined && (!Number.isInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength > 4096)) ||
        (schema.min !== undefined && !Number.isFinite(schema.min)) || (schema.max !== undefined && !Number.isFinite(schema.max)) ||
        (schema.min !== undefined && schema.max !== undefined && schema.min > schema.max)) {
      fail('operation_refused', 'Remote database parameter schema is invalid.');
    }
  }
  if (!server && (!Array.isArray(op.parameter_order) || op.parameter_order.length > 64 ||
      op.parameter_order.some(name => typeof name !== 'string' || !Object.hasOwn(op.parameters, name)) ||
      new Set(op.parameter_order).size !== Object.keys(op.parameters).length)) {
    fail('operation_refused', 'Positional parameters require an explicit complete parameter_order.');
  }
  let parsed;
  try { const { Parser } = require(`node-sql-parser/build/${dialects[op.type]}`); parsed = new Parser().parse(op.query); }
  catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') fail('execution_failed', 'Install the private gateway package dependencies before using remote databases.');
    fail('operation_refused', 'Configured SQL must parse as one supported read-only SELECT statement.');
  }
  const statements = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];
  if (statements.length !== 1 || statements[0]?.type !== 'select' || parsed.tableList.some(table => !table.startsWith('select::'))) {
    fail('operation_refused', 'Only one read-only SELECT or SELECT CTE is permitted.');
  }
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (mutation.has(node.type) || node.type === 'into' || node.into?.position || node.locking_read || node.for ||
        (server && node.db)) fail('operation_refused', 'Mutation, locking reads and cross-database SQL Server references are refused.');
    for (const value of Object.values(node)) visit(value);
  };
  visit(statements[0]);
}

export function validateRemoteInput(op, input) {
  if (!isObject(input) || Object.keys(input).some(key => !Object.hasOwn(op.parameters, key))) fail('invalid_input', 'Task contains undeclared parameters.');
  for (const [name, schema] of Object.entries(op.parameters)) {
    const value = input[name];
    if (value === undefined && schema.optional) continue;
    const valid = schema.type === 'integer' ? Number.isSafeInteger(value) : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === schema.type;
    if (!valid || (typeof value === 'string' && value.length > (schema.maxLength ?? 4096)) ||
        (typeof value === 'number' && ((schema.min !== undefined && value < schema.min) || (schema.max !== undefined && value > schema.max)))) {
      fail('invalid_input', 'Task parameter failed its local type or bound.');
    }
  }
}

export function rowCollector(maxRows) {
  const rows = []; let bytes = Buffer.byteLength('{"rows":[]}');
  const normalize = value => {
    if (typeof value === 'string' && value.length > MAX_OUTPUT_BYTES) fail('output_limit', 'Remote database output exceeds 64 KiB.');
    if (typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) return String(value);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) {
      if (value.byteLength > MAX_OUTPUT_BYTES) fail('output_limit', 'Remote database output exceeds 64 KiB.');
      return { encoding: 'base64', data: Buffer.from(value).toString('base64') };
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    return value;
  };
  return {
    output: { rows },
    add(row) {
      if (rows.length >= maxRows) fail('output_limit', 'Remote database result exceeds its configured row bound.');
      const normalized = normalize(row), encoded = JSON.stringify(normalized);
      bytes += Buffer.byteLength(encoded) + (rows.length ? 1 : 0);
      if (bytes > MAX_OUTPUT_BYTES) fail('output_limit', 'Remote database output exceeds 64 KiB.');
      rows.push(normalized);
    },
  };
}

export function databaseFailure(error) {
  if (error instanceof GatewayError) return error;
  return new GatewayError(['57014', 'ETIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_QUERY_TIMEOUT'].includes(error?.code) ? 'timeout' : 'execution_failed', 'Configured remote database query failed or timed out.');
}
