import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const fixture = number => `synthetic-crank-${number}`;
const docker = process.env.CRANK_DOCKER ?? 'docker';
const secrets = [fixture(23), fixture(24), fixture(33), fixture(34)];
export const registerPrivate = value => { if (typeof value === 'string' && value) secrets.push(value); };
export const sanitized = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[private fixture credential]'), String(value));

/** Spawn only our own commands. Never put command arguments or credentials in errors. */
export function command(binary, args, { input, timeout = 30000, signal, expected = 0, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '', oversized = false, expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
    const capture = target => bytes => {
      if (stdout.length + stderr.length + bytes.length > 128 * 1024) { oversized = true; child.kill('SIGKILL'); return; }
      if (target === 'stdout') stdout += bytes; else stderr += bytes;
    };
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Owned command could not start (${error.code ?? error.name}).`)); });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      if (oversized || expired || exitSignal) return reject(new Error(`Owned command exceeded its output/time bound or was interrupted (${exitSignal ?? 'bound'}).`));
      if (expected !== null && code !== expected) return reject(new Error(`Owned command failed (${code}): ${sanitized(stderr)}`));
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export function databaseFixtures(signal) {
  const owned = [];
  const postgres = { kind: 'postgres', image: 'postgres:17', database: fixture(20), admin: fixture(21), user: fixture(22),
    adminPassword: fixture(23), password: fixture(24), privatePort: 5432 };
  const mysql = { kind: 'mysql', image: 'mysql:8.4', database: fixture(30), admin: 'root', user: fixture(32),
    adminPassword: fixture(33), password: fixture(34), privatePort: 3306 };
  const providers = [postgres, mysql];
  const run = (args, options = {}) => command(docker, args, { signal, ...options });
  const sql = (provider, statement, { reader = false, expected = 0 } = {}) => {
    const user = reader ? provider.user : provider.admin, password = reader ? provider.password : provider.adminPassword;
    const cli = provider.kind === 'postgres' ? ['psql', '--no-psqlrc', '--host=127.0.0.1', '--username', user, '--dbname', provider.database,
      '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--set', 'VERBOSITY=sqlstate'] :
      ['mysql', '--protocol=TCP', '--host=127.0.0.1', '--user=' + user, '--database=' + provider.database, '--batch', '--raw', '--skip-column-names'];
    return run(['exec', '--interactive', '--env', (provider.kind === 'postgres' ? 'PGPASSWORD=' : 'MYSQL_PWD=') + password, provider.id, ...cli],
      { input: statement + '\n', timeout: 12000, expected });
  };
  async function ready(provider) {
    const deadline = Date.now() + 120000;
    for (;;) {
      signal?.throwIfAborted();
      const probe = await sql(provider, 'SELECT 1;', { expected: null });
      if (probe.code === 0 && probe.stdout.trim() === '1') return;
      if (Date.now() >= deadline) throw new Error(`${provider.kind} did not become ready within two minutes.`);
      await delay(500, undefined, { signal });
    }
  }
  async function start(provider) {
    // Pull only the two explicitly requested official images. No shared daemon setup.
    await run(['pull', '--quiet', provider.image], { timeout: 240000 });
    const environment = provider.kind === 'postgres' ? ['POSTGRES_USER=' + provider.admin, 'POSTGRES_PASSWORD=' + provider.adminPassword, 'POSTGRES_DB=' + provider.database] :
      ['MYSQL_ROOT_PASSWORD=' + provider.adminPassword, 'MYSQL_DATABASE=' + provider.database];
    provider.name = `synthetic-crank-database-${randomUUID()}`;
    const args = ['create', '--name', provider.name, '--memory', provider.kind === 'postgres' ? '512m' : '768m', '--cpus', '1',
      '--publish', `127.0.0.1::${provider.privatePort}`, '--tmpfs', provider.kind === 'postgres' ? '/var/lib/postgresql/data:rw,nosuid,size=256m' : '/var/lib/mysql:rw,nosuid,size=512m',
      ...environment.flatMap(value => ['--env', value]), provider.image];
    if (provider.kind === 'mysql') args.push('--innodb-buffer-pool-size=32M', '--innodb-redo-log-capacity=16M', '--performance-schema=OFF', '--mysqlx=OFF', '--max-connections=10');
    const created = await run(args), id = created.stdout.trim();
    assert.match(id, /^[a-f0-9]{64}$/, 'Docker must return the exact new container ID'); provider.id = id; owned.push(id);
    await run(['start', provider.id]);
    const published = (await run(['port', provider.id, provider.privatePort + '/tcp'])).stdout.trim();
    assert.match(published, /^127\.0\.0\.1:\d+$/, 'database port must bind only loopback'); provider.port = Number(published.split(':')[1]);
    await ready(provider);
    provider.imageId = (await run(['inspect', '--format', '{{.Image}}', provider.id])).stdout.trim();
    const table = "CREATE TABLE stock(name VARCHAR(100) PRIMARY KEY, quantity INTEGER NOT NULL); INSERT INTO stock VALUES ('synthetic-crank-41',24),('synthetic-crank-42',9),('synthetic-crank-43',12);";
    await sql(provider, provider.kind === 'postgres' ? `${table}
      CREATE USER "${provider.user}" PASSWORD '${provider.password}';
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      REVOKE TEMPORARY ON DATABASE "${provider.database}" FROM PUBLIC;
      GRANT CONNECT ON DATABASE "${provider.database}" TO "${provider.user}";
      GRANT USAGE ON SCHEMA public TO "${provider.user}";
      GRANT SELECT ON stock TO "${provider.user}";` : `${table}
      CREATE USER '${provider.user}'@'%' IDENTIFIED BY '${provider.password}';
      GRANT SELECT ON \`${provider.database}\`.stock TO '${provider.user}'@'%';`);
    assert.equal((await sql(provider, 'SELECT quantity FROM stock WHERE name=\'synthetic-crank-41\';', { reader: true })).stdout.trim(), '24');
    const refused = await sql(provider, "START TRANSACTION READ WRITE; UPDATE stock SET quantity=25 WHERE name='synthetic-crank-41'; ROLLBACK;", { reader: true, expected: null });
    assert.notEqual(refused.code, 0, 'independent read-only database credentials must reject UPDATE even in a read-write transaction');
    assert.match(refused.stderr, provider.kind === 'postgres' ? /42501/ : /ERROR 1142/, 'write refusal must be the real database permission error');
    assert.equal((await sql(provider, 'SELECT quantity FROM stock WHERE name=\'synthetic-crank-41\';')).stdout.trim(), '24', 'provider readback proves write refusal');
  }
  return {
    providers,
    async start() {
      const results = await Promise.allSettled(providers.map(start));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    },
    connection(provider) { return { host: '127.0.0.1', port: provider.port, database: provider.database, user: provider.user, password: provider.password, ssl: false }; },
    async idle(provider) {
      const statement = provider.kind === 'postgres' ? `SELECT count(*) FROM pg_stat_activity WHERE usename='${provider.user}';` :
        `SELECT count(*) FROM information_schema.processlist WHERE USER='${provider.user}';`;
      const deadline = Date.now() + 8000;
      while ((await sql(provider, statement)).stdout.trim() !== '0') {
        if (Date.now() > deadline) throw new Error(`${provider.kind} retained a gateway database session after the CLI exited.`);
        await delay(100, undefined, { signal });
      }
    },
    async close() {
      // Cleanup ignores the journey abort signal and touches only IDs returned by our creates.
      // Recover an acknowledged create if our Docker client was interrupted before
      // its stdout reached us. The random names are exclusive to this invocation.
      for (const provider of providers.filter(value => value.name && !value.id)) {
        const recovered = await command(docker, ['inspect', '--type=container', '--format', '{{.Id}}', provider.name], { expected: null });
        if (recovered.code === 0) { const id = recovered.stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/); owned.push(id); }
        else if (!/No such (object|container)/i.test(recovered.stderr)) throw new Error('Could not recover an interrupted container creation for cleanup: ' + sanitized(recovered.stderr));
      }
      const results = await Promise.allSettled([...new Set(owned)].map(id => command(docker, ['rm', '--force', '--volumes', id], { timeout: 30000 })));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    },
  };
}
