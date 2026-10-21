import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { command, fixture, registerPrivate } from './database-gateway-fixture.mjs';

const require = createRequire(new URL('../gateways/node/package.json', import.meta.url));
const docker = process.env.CRANK_DOCKER ?? 'docker';
const identifier = value => '[' + value.replaceAll(']', ']]') + ']';

/** Real SQL Server, owned by this invocation. Credentials never enter argv or logs. */
export function sqlserverFixture(signal) {
  const provider = { image: 'mcr.microsoft.com/mssql/server:2022-latest', database: fixture(401), user: fixture(402),
    password: `${fixture(403)}-Aa9!${randomBytes(18).toString('hex')}`,
    adminPassword: `${fixture(404)}-Aa9!${randomBytes(18).toString('hex')}` };
  registerPrivate(provider.password); registerPrivate(provider.adminPassword);
  let sql, directory;
  const run = (args, options = {}) => command(docker, args, { signal, ...options });
  const connection = (reader = true, database = provider.database) => ({ server: '127.0.0.1', port: provider.port,
    database, user: reader ? provider.user : 'sa', password: reader ? provider.password : provider.adminPassword,
    // The isolated container has a self-signed certificate. This exception stays on loopback.
    options: { encrypt: true, trustServerCertificate: true } });

  async function query(statement, { reader = false, database = provider.database, refusal = false } = {}) {
    signal?.throwIfAborted();
    const pool = new sql.ConnectionPool({ ...connection(reader, database), connectionTimeout: 3000, requestTimeout: 5000,
      pool: { max: 1, min: 0, idleTimeoutMillis: 1000 }, options: { ...connection(reader, database).options, maxRetriesOnTransientErrors: 0 } });
    pool.on('error', () => {});
    try {
      await pool.connect();
      const result = await pool.request().query(statement);
      assert(!refusal, 'the restricted SQL Server login must refuse the attempted mutation');
      return result.recordset?.map(row => ({ ...row }));
    } catch (error) {
      if (refusal && [229, 3906].includes(error.number)) return;
      // SQL Server errors can embed SQL text. Keep only their numeric class.
      throw new Error(`SQL Server fixture command failed (number=${Number.isInteger(error.number) ? error.number : 'unavailable'}).`);
    } finally { await pool.close(); }
  }

  async function readOnly(enabled) {
    await query(`ALTER DATABASE ${identifier(provider.database)} SET ${enabled ? 'READ_ONLY' : 'READ_WRITE'} WITH ROLLBACK IMMEDIATE;`, { database: 'master' });
    const rows = await query("SELECT CONVERT(nvarchar(60), DATABASEPROPERTYEX(DB_NAME(), 'Updateability')) AS access_mode;");
    assert.equal(rows[0]?.access_mode, enabled ? 'READ_ONLY' : 'READ_WRITE', 'the real server must confirm database updateability');
  }

  return {
    provider, connection: () => connection(), readOnly,
    async start() {
      sql = require('mssql');
      directory = await mkdtemp(join(tmpdir(), fixture(405) + '-'));
      const environment = join(directory, fixture(406));
      await writeFile(environment, `ACCEPT_EULA=Y\nMSSQL_PID=Developer\nMSSQL_SA_PASSWORD=${provider.adminPassword}\nMSSQL_MEMORY_LIMIT_MB=2048\n`, { mode: 0o600 });
      await run(['pull', '--quiet', '--platform', 'linux/amd64', provider.image], { timeout: 300000 });
      provider.name = `synthetic-crank-sqlserver-${randomUUID()}`;
      const created = await run(['create', '--platform', 'linux/amd64', '--name', provider.name, '--memory', '3g', '--cpus', '2',
        '--publish', '127.0.0.1::1433', '--env-file', environment, provider.image]);
      provider.id = created.stdout.trim();
      assert.match(provider.id, /^[a-f0-9]{64}$/, 'Docker must return the exact owned container ID');
      await run(['start', provider.id]);
      const published = (await run(['port', provider.id, '1433/tcp'])).stdout.trim();
      assert.match(published, /^127\.0\.0\.1:\d+$/, 'SQL Server must bind only loopback');
      provider.port = Number(published.split(':')[1]);
      const deadline = Date.now() + 150000;
      for (;;) {
        signal?.throwIfAborted();
        try { assert.equal((await query('SELECT 1 AS ready;', { database: 'master' }))[0]?.ready, 1); break; }
        catch { if (Date.now() >= deadline) throw new Error('The real SQL Server did not become ready within its startup bound.'); }
        await delay(1000, undefined, { signal });
      }
      provider.imageId = (await run(['inspect', '--format', '{{.Image}}', provider.id])).stdout.trim();
      assert.match(provider.imageId, /^sha256:[a-f0-9]{64}$/, 'record the actual SQL Server image used');
      await query(`CREATE DATABASE ${identifier(provider.database)};`, { database: 'master' });
      await query(`CREATE LOGIN ${identifier(provider.user)} WITH PASSWORD='${provider.password}', CHECK_POLICY=ON, DEFAULT_DATABASE=${identifier(provider.database)};`, { database: 'master' });
      await query(`CREATE TABLE stock(name nvarchar(100) PRIMARY KEY, quantity int NOT NULL, payload nvarchar(max));
        INSERT INTO stock VALUES ('${fixture(41)}',24,REPLICATE(CONVERT(nvarchar(max),'a'),65537)),('${fixture(42)}',9,NULL),('${fixture(43)}',12,NULL);
        CREATE USER ${identifier(provider.user)} FOR LOGIN ${identifier(provider.user)};
        GRANT SELECT ON OBJECT::stock TO ${identifier(provider.user)};
        DENY INSERT, UPDATE, DELETE ON OBJECT::stock TO ${identifier(provider.user)};
        DENY CREATE TABLE TO ${identifier(provider.user)};`);
      // Prove login permissions separately while the database is still writable.
      assert.deepEqual(await query("SELECT IS_SRVROLEMEMBER('sysadmin') AS sysadmin, HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') AS can_write;", { reader: true }),
        [{ sysadmin: 0, can_write: 0 }]);
      await query(`UPDATE stock SET quantity=25 WHERE name='${fixture(41)}';`, { reader: true, refusal: true });
      assert.deepEqual(await query(`SELECT quantity FROM stock WHERE name='${fixture(41)}';`, { reader: true }), [{ quantity: 24 }]);
      await readOnly(true);
      await query(`UPDATE stock SET quantity=25 WHERE name='${fixture(41)}';`, { reader: true, refusal: true });
    },
    async idle() {
      const deadline = Date.now() + 8000;
      while ((await query(`SELECT COUNT(*) AS sessions FROM sys.dm_exec_sessions WHERE login_name='${provider.user}';`, { database: 'master' }))[0]?.sessions !== 0) {
        if (Date.now() >= deadline) throw new Error('SQL Server retained a gateway database session after the CLI exited.');
        await delay(100, undefined, { signal });
      }
    },
    async close() {
      try {
        // Ignore abort for cleanup. Recover only this invocation's random create name.
        if (provider.name && !provider.id) {
          const recovered = await command(docker, ['inspect', '--type=container', '--format', '{{.Id}}', provider.name], { expected: null });
          if (recovered.code === 0) provider.id = recovered.stdout.trim();
          else if (!/No such (object|container)/i.test(recovered.stderr)) throw new Error('Could not recover the owned SQL Server container for cleanup.');
        }
        if (provider.id) {
          assert.match(provider.id, /^[a-f0-9]{64}$/);
          await command(docker, ['rm', '--force', '--volumes', provider.id], { timeout: 30000 });
        }
      } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    },
  };
}
