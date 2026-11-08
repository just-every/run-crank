import { createHash } from 'node:crypto';
import { GatewayError, fail, isObject, MAX_OUTPUT_BYTES } from './errors.mjs';
import { validateRemoteInput, rowCollector, databaseFailure } from './remote-databases-policy.mjs';
import { normalizedHost, resolveDestination, pinnedSocket } from './network-policy.mjs';

const identifier = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value);
const relation = value => typeof value === 'string' && value.split('.').length === 2 && value.split('.').every(identifier);
const quote = value => '"' + value + '"';
const table = value => value.split('.').map(quote).join('.');
const refused = () => fail('operation_refused', 'PostgreSQL commands require an explicit bounded structured write and provisioned receipt table.');
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

export function validatePostgresCommand(op) {
  if (!isObject(op) || op.type !== 'postgres-command' || op.write !== true || !isObject(op.connection) ||
      !relation(op.receipt_table) || !isObject(op.command) || !isObject(op.parameters) || Object.keys(op.parameters).length > 32 ||
      typeof op.connector_operation !== 'string' || !op.connector_operation || op.connector_operation.length > 512 ||
      typeof op.credential !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(op.credential)) refused();
  const c = op.connection, cmd = op.command;
  if (Object.keys(c).some(key => !['host', 'port', 'database', 'user', 'password', 'ssl'].includes(key)) ||
      !Number.isInteger(c.port) || c.port < 1 || c.port > 65535 ||
      ['database', 'user', 'password'].some(key => typeof c[key] !== 'string' || !c[key] || c[key].length > (key === 'password' ? 4096 : 512))) refused();
  const host = normalizedHost(c.host), local = ['localhost', '127.0.0.1', '::1'].includes(host);
  if ((!local && !c.ssl) || (c.ssl !== undefined && typeof c.ssl !== 'boolean' && !isObject(c.ssl)) ||
      (isObject(c.ssl) && Object.keys(c.ssl).some(key => key !== 'ca'))) refused();
  if (Object.keys(cmd).some(key => !['action', 'table', 'values', 'key', 'returning'].includes(key)) ||
      !['insert', 'update'].includes(cmd.action) || !relation(cmd.table) || cmd.table === op.receipt_table ||
      !isObject(cmd.values) || !isObject(cmd.key) || Object.keys(cmd.values).length < 1 || Object.keys(cmd.values).length > 32 ||
      Object.keys(cmd.key).length < 1 || Object.keys(cmd.key).length > 8 ||
      !Array.isArray(cmd.returning) || cmd.returning.length < 1 || cmd.returning.length > 32 ||
      !cmd.returning.every(identifier) || new Set(cmd.returning).size !== cmd.returning.length) refused();
  const used = new Set();
  for (const mapping of [cmd.values, cmd.key]) for (const [column, parameter] of Object.entries(mapping)) {
    if (!identifier(column) || typeof parameter !== 'string' || !Object.hasOwn(op.parameters, parameter)) refused();
    used.add(parameter);
  }
  for (const [name, schema] of Object.entries(op.parameters)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || !used.has(name) || !isObject(schema) || schema.optional === true ||
        !['string', 'integer', 'number', 'boolean'].includes(schema.type) ||
        (schema.type === 'string' && (!Number.isInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength > 4096)) ||
        (['integer', 'number'].includes(schema.type) && (!Number.isFinite(schema.min) || !Number.isFinite(schema.max) || schema.min > schema.max))) refused();
  }
  for (const [column, parameter] of Object.entries(cmd.key)) {
    if (!cmd.returning.includes(column) || (cmd.action === 'insert' ? cmd.values[column] !== parameter : Object.hasOwn(cmd.values, column))) refused();
  }
  // There is deliberately no query text, expression, conflict action or SQL supplied by a task.
  if (['query', 'parameter_order', 'read_only_credentials'].some(key => Object.hasOwn(op, key))) refused();
  return op;
}

function checkedOutput(output) {
  if (!isObject(output) || !Array.isArray(output.rows) || output.rows.length !== 1 ||
      Buffer.byteLength(JSON.stringify(output)) > MAX_OUTPUT_BYTES) {
    fail('output_limit', 'PostgreSQL command readback must be one row within 64 KiB.');
  }
  return output;
}

/** The customer-provisioned receipt and business effect commit together. A killed
 * process or lost acknowledgement can only leave both committed or both absent. */
export async function executePostgresCommand(op, input, task) {
  validatePostgresCommand(op);
  validateRemoteInput(op, input);
  if (task.method !== 'POST' || typeof task.operation_key !== 'string' || !task.operation_key || task.operation_key.length > 512) refused();
  const binding = digest({ protocol: 'crank-postgres-command-v1', installation: task.installation, environment: task.environment,
    connector_id: task.connector_id, connector_version: task.connector_version, connector_operation: task.connector_operation,
    operation: task.operation, destination: task.destination, connection: { host: normalizedHost(op.connection.host), port: op.connection.port,
      database: op.connection.database }, receipt_table: op.receipt_table, command: op.command, parameters: op.parameters });
  const inputDigest = digest(input), receipt = table(op.receipt_table);
  let client;
  try {
    const { default: pg } = await import('pg');
    const address = await resolveDestination(op.connection.host);
    client = new pg.Client({ ...op.connection, ...(op.connection.ssl ? { ssl: { ...(isObject(op.connection.ssl) ? op.connection.ssl : {}), rejectUnauthorized: true } } : {}),
      stream: () => pinnedSocket(address), query_timeout: 0, statement_timeout: 3500, lock_timeout: 3000,
      connectionTimeoutMillis: 3500, idle_in_transaction_session_timeout: 3500, application_name: 'crank-private-gateway-command' });
    client.on('error', () => {});
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL search_path = pg_catalog; SET LOCAL statement_timeout = '3500ms'; SET LOCAL lock_timeout = '3000ms'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [task.operation_key]);
    const existing = await client.query(`SELECT binding_digest,input_digest,output_json FROM ${receipt} WHERE operation_key=$1`, [task.operation_key]);
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (!row || row.binding_digest !== binding || row.input_digest !== inputDigest || row.output_json === null) {
        fail('operation_refused', 'Operation key already belongs to different inputs or a different PostgreSQL command binding.');
      }
      const output = checkedOutput(row.output_json);
      await client.query('COMMIT');
      return output;
    }
    if (task.recovery_only === true) fail('operation_refused', 'No committed PostgreSQL receipt exists; recovery cannot execute a write.');
    await client.query(`INSERT INTO ${receipt} (operation_key,binding_digest,input_digest,output_json) VALUES ($1,$2,$3,NULL)`, [task.operation_key, binding, inputDigest]);
    const cmd = op.command, target = table(cmd.table), values = [], bind = parameter => { values.push(input[parameter]); return '$' + values.length; };
    const entries = Object.entries(cmd.values);
    let statement;
    if (cmd.action === 'insert') {
      statement = `INSERT INTO ${target} (${entries.map(([column]) => quote(column)).join(',')}) VALUES (${entries.map(([, parameter]) => bind(parameter)).join(',')})`;
    } else {
      const assignments = entries.map(([column, parameter]) => `${quote(column)}=${bind(parameter)}`).join(',');
      const where = Object.entries(cmd.key).map(([column, parameter]) => `${quote(column)}=${bind(parameter)}`).join(' AND ');
      // A scalar subquery refuses ambiguous keys before UPDATE; ONLY prevents
      // inherited tables sharing a ctid from widening this bounded write.
      statement = `WITH target AS (SELECT ctid FROM ONLY ${target} WHERE ${where} LIMIT 2 FOR UPDATE) UPDATE ONLY ${target} SET ${assignments} WHERE ctid=(SELECT ctid FROM target)`;
    }
    const written = await client.query(statement, values);
    if (written.rowCount !== 1) fail('execution_failed', 'PostgreSQL command did not affect exactly one business row.');
    const keys = Object.entries(cmd.key), reread = await client.query(`SELECT ${cmd.returning.map(quote).join(',')} FROM ONLY ${target} WHERE ${keys.map(([column], index) => `${quote(column)}=$${index + 1}`).join(' AND ')} LIMIT 2`, keys.map(([, parameter]) => input[parameter]));
    const collected = rowCollector(1);
    for (const row of reread.rows) collected.add(row);
    const output = checkedOutput(collected.output);
    const saved = await client.query(`UPDATE ${receipt} SET output_json=$2::jsonb WHERE operation_key=$1`, [task.operation_key, JSON.stringify(output)]);
    if (saved.rowCount !== 1) fail('execution_failed', 'PostgreSQL command receipt could not be saved.');
    await client.query('COMMIT');
    return output;
  } catch (error) {
    // COMMIT may have reached the server even if its reply was lost. Never
    // retry here; the next explicit same-key dispatch consults the receipt.
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
      throw new GatewayError('execution_failed', 'Install the private gateway package dependencies before using PostgreSQL commands.');
    }
    if (op.command.action === 'insert' && error?.code === '23505') throw new GatewayError('duplicate_conflict', 'The unique business key already exists; read it back before any new action.');
    throw databaseFailure(error);
  } finally { if (client) await client.end().catch(() => {}); }
}
