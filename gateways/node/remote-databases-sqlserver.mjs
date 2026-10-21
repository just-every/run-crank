import { fail } from './errors.mjs';
import { rowCollector } from './remote-databases-policy.mjs';

export async function sqlserverQuery(op, input) {
  const { default: sql } = await import('mssql');
  const pool = new sql.ConnectionPool({ ...op.connection, connectionTimeout: 5000, requestTimeout: 5000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 5000, acquireTimeoutMillis: 5000 },
    options: { ...op.connection.options, readOnlyIntent: true, requestTimeout: 5000,
      connectTimeout: 5000, maxRetriesOnTransientErrors: 0 } });
  pool.on('error', () => {});
  let transaction, begun = false;
  try {
    await pool.connect();
    transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED); begun = true;
    const proof = await new sql.Request(transaction, { requestTimeout: 5000 }).query(
      "SELECT CONVERT(nvarchar(60), DATABASEPROPERTYEX(DB_NAME(), 'Updateability')) AS access_mode");
    if (proof.recordset?.length !== 1 || proof.recordset[0].access_mode !== 'READ_ONLY') {
      fail('operation_refused', 'SQL Server requires a verified READ_ONLY database; server-permission setup is pending.');
    }
    const request = new sql.Request(transaction, { requestTimeout: 5000 });
    request.stream = true;
    for (const [name, schema] of Object.entries(op.parameters)) {
      const type = schema.type === 'integer' ? sql.BigInt : schema.type === 'number' ? sql.Float : schema.type === 'boolean' ? sql.Bit :
        sql.NVarChar((schema.maxLength ?? 4096) <= 4000 ? (schema.maxLength ?? 4096) : sql.MAX);
      request.input(name, type, input[name] ?? null);
    }
    const collected = rowCollector(op.maxRows);
    await new Promise((resolve, reject) => {
      let failure;
      request.on('row', row => {
        if (failure) return;
        try { collected.add(row); }
        catch (error) { failure = error; request.cancel(); }
      });
      request.on('error', error => { failure ??= error; });
      request.once('done', () => failure ? reject(failure) : resolve());
      request.query(op.query, error => { if (error) failure ??= error; });
    });
    await transaction.rollback(); begun = false;
    return collected.output;
  } finally {
    if (begun) await transaction.rollback().catch(() => {});
    await pool.close();
  }
}
