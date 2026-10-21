import { validateRemoteDatabase, executeRemoteDatabase } from './remote-databases.mjs';
import { validateStorage, executeStorage } from './storage.mjs';
import { validatePostgresCommand, executePostgresCommand } from './postgres-command.mjs';
import { open, constants } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileLines } from './file-lines.mjs';
import { GatewayError, fail, isObject, MAX_OUTPUT_BYTES } from './errors.mjs';
import { withCredentials } from './credentials.mjs';
import { authorizeTask } from './authority.mjs';
export { GatewayError, isObject, MAX_OUTPUT_BYTES } from './errors.mjs';

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

export async function readPrivateJson(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) {
      fail('configuration', 'Private configuration must be a regular mode-0600 file within 1 MiB.');
    }
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    fail('configuration', 'Private configuration could not be read.');
  } finally { await file?.close(); }
}

export function validateManifest(manifest) {
  if (!isObject(manifest) || manifest.version !== 1 || !isObject(manifest.operations) ||
      Object.keys(manifest.operations).length > 100 ||
      (manifest.credentials !== undefined && (!isObject(manifest.credentials) || Object.keys(manifest.credentials).length > 100))) fail('configuration', 'Invalid gateway manifest.');
  for (const [name, op] of Object.entries(manifest.operations)) {
    if (!text(name) || !isObject(op) || !text(op.connector_id) || (!Number.isSafeInteger(op.connector_version) || op.connector_version < 1) ||
        !text(op.destination) || (op.connector_operation !== undefined && !text(op.connector_operation)) ||
        !isObject(op.parameters) || Object.keys(op.parameters).length > 32) {
      fail('configuration', 'Invalid operation binding.');
    }
    for (const [parameter, schema] of Object.entries(op.parameters)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(parameter) || !isObject(schema) ||
          !['string', 'integer', 'number', 'boolean'].includes(schema.type) ||
          (schema.optional !== undefined && typeof schema.optional !== 'boolean') ||
          (schema.maxLength !== undefined && (!Number.isInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength > 4096)) ||
          (schema.min !== undefined && !Number.isFinite(schema.min)) ||
          (schema.max !== undefined && !Number.isFinite(schema.max)) ||
          (schema.min !== undefined && schema.max !== undefined && schema.min > schema.max)) {
        fail('configuration', 'Invalid parameter schema.');
      }
    }
    if (op.type === 'postgres-command') {
      validatePostgresCommand(withCredentials(manifest, op));
    } else if (['postgres-query','mysql-query','sqlserver-query'].includes(op.type)) {
      validateRemoteDatabase(withCredentials(manifest, op));
    } else if (['sftp-lines', 's3-lines'].includes(op.type)) {
      validateStorage(withCredentials(manifest, op));
    } else if (op.type === 'sqlite-query') {
      if (!text(op.database) || typeof op.query !== 'string' || op.query.length > 16384 ||
          !/^\s*(SELECT|WITH)\b/i.test(op.query) || !Number.isInteger(op.maxRows) || op.maxRows < 1 || op.maxRows > 1000) {
        fail('configuration', 'Invalid SQLite operation.');
      }
    } else if (op.type === 'file-lines') {
      if (!text(op.path) || !Number.isInteger(op.pageLines) || op.pageLines < 1 || op.pageLines > 1000 ||
          Object.keys(op.parameters).some(key => !['cursor', 'limit'].includes(key)) ||
          (op.parameters.cursor && (op.parameters.cursor.type !== 'string' || !op.parameters.cursor.optional)) ||
          (op.parameters.limit && (op.parameters.limit.type !== 'integer' || !op.parameters.limit.optional))) {
        fail('configuration', 'Invalid file operation.');
      }
    } else fail('configuration', 'Unsupported operation type.');
  }
  return manifest;
}

function validateInput(op, input) {
  if (!isObject(input) || Object.keys(input).some(key => !Object.hasOwn(op.parameters, key))) {
    fail('invalid_input', 'Task contains undeclared parameters.');
  }
  for (const [name, schema] of Object.entries(op.parameters)) {
    const value = input[name];
    if (value === undefined && schema.optional) continue;
    const valid = schema.type === 'integer' ? Number.isSafeInteger(value) :
      schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === schema.type;
    if (!valid || (typeof value === 'string' && value.length > (schema.maxLength ?? 4096)) ||
        (typeof value === 'number' && ((schema.min !== undefined && value < schema.min) || (schema.max !== undefined && value > schema.max)))) {
      fail('invalid_input', 'Task parameter failed its local type or bound.');
    }
  }
}

function bounded(output) {
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_OUTPUT_BYTES) fail('output_limit', 'Operation output exceeds 64 KiB.');
  return output;
}

async function sqliteQuery(op, input, base) {
  const { DatabaseSync } = await import('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(resolve(base, op.database), { readOnly: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA hard_heap_limit=16777216; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048');
    const statement = db.prepare(op.query);
    statement.setAllowBareNamedParameters(false);
    statement.setReadBigInts(true);
    const bindings = Object.fromEntries(Object.entries(input).map(([key, value]) => [`:${key}`, typeof value === 'boolean' ? Number(value) : value]));
    const rows = [];
    for (const row of statement.iterate(bindings)) {
      if (rows.length >= op.maxRows) fail('output_limit', 'SQLite result exceeds its configured row bound.');
      rows.push(Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        typeof value === 'bigint' ? (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : String(value)) :
          value instanceof Uint8Array ? { encoding: 'base64', data: Buffer.from(value).toString('base64') } : value])));
      bounded({ rows });
    }
    return { rows };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    fail('execution_failed', 'Configured SQLite query could not be completed.');
  } finally { db?.close(); }
}

export async function executeTask(manifest, manifestPath, task, authority) {
  const op = withCredentials(manifest, authorizeTask(manifest, manifestPath, task, authority));
  if (!text(task.operation_key)) fail('invalid_input', 'Task operation key is required.');
  validateInput(op, task.input);
  const base = dirname(resolve(manifestPath));
  if (op.type === 'postgres-command') return bounded(await executePostgresCommand(op, task.input, task));
  if(['postgres-query','mysql-query','sqlserver-query'].includes(op.type))return bounded(await executeRemoteDatabase(op,task.input));
  if (['sftp-lines', 's3-lines'].includes(op.type)) return bounded(await executeStorage(op, task.input));
  return bounded(await (op.type === 'sqlite-query' ? sqliteQuery(op, task.input, base) : fileLines(op, task.input, base)));
}
