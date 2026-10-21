import { rowCollector } from './remote-databases-policy.mjs';
import { resolveDestination, pinnedSocket, connectPinned } from './network-policy.mjs';

export async function postgresQuery(op, input) {
  const [{ default: pg }, { default: Cursor }] = await Promise.all([import('pg'), import('pg-cursor')]);
  const address = await resolveDestination(op.connection.host);
  const client = new pg.Client({ ...op.connection, stream: () => pinnedSocket(address), query_timeout: 0, statement_timeout: 5000, lock_timeout: 5000,
    connectionTimeoutMillis: 5000, idle_in_transaction_session_timeout: 5000, application_name: 'crank-private-gateway' });
  client.on('error', () => {}); // Query/cursor promises own reporting; never print driver exceptions.
  const collected = rowCollector(op.maxRows);
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const cursor = client.query(new Cursor(op.query, op.parameter_order.map(name => input[name] ?? null)));
    try {
      for (;;) {
        const rows = await cursor.read(1);
        if (!rows.length) break;
        collected.add(rows[0]);
      }
    } finally { await cursor.close(); }
    await client.query('ROLLBACK');
    return collected.output;
  } finally { await client.end(); }
}

function mysqlCommand(connection, sql) {
  return new Promise((resolve, reject) => connection.query({ sql, timeout: 5000 }, error => error ? reject(error) : resolve()));
}

export async function mysqlQuery(op, input) {
  const { default: mysql } = await import('mysql2');
  const address = await resolveDestination(op.connection.host);
  const connection = mysql.createConnection({ ...op.connection, stream: () => connectPinned(address, op.connection.port),
    ...(op.connection.ssl ? { ssl: { ...(typeof op.connection.ssl === 'object' ? op.connection.ssl : {}), rejectUnauthorized: true, verifyIdentity: true } } : {}),
    connectTimeout: 5000, multipleStatements: false,
    namedPlaceholders: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, decimalNumbers: false });
  connection.on('error', () => {});
  const collected = rowCollector(op.maxRows);
  try {
    await new Promise((resolve, reject) => connection.connect(error => error ? reject(error) : resolve()));
    // Unsupported server/session controls fail; there is no writable compatibility path.
    await mysqlCommand(connection, 'SET SESSION max_execution_time = 5000');
    await mysqlCommand(connection, 'SET SESSION TRANSACTION READ ONLY');
    await mysqlCommand(connection, 'START TRANSACTION READ ONLY');
    await new Promise((resolve, reject) => {
      let failed = false;
      // No callback: mysql2 emits rows instead of accumulating a result array.
      const query = connection.execute({ sql: op.query, timeout: 5000 }, op.parameter_order.map(name => input[name] ?? null));
      query.on('result', row => {
        if (failed) return;
        try { collected.add(row); }
        catch (error) { failed = true; connection.destroy(); reject(error); }
      });
      query.on('error', error => { failed = true; reject(error); });
      query.once('end', () => { if (!failed) resolve(); });
    });
    await mysqlCommand(connection, 'ROLLBACK');
    return collected.output;
  } finally { connection.destroy(); }
}
