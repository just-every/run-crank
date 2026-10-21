import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { command, fixture, registerPrivate } from './database-gateway-fixture.mjs';

/** A real PostgreSQL server; administration uses an independent docker psql
 * connection, never the gateway connection or its returned output. */
export function postgresWriteFixture(signal) {
  const docker = process.env.CRANK_DOCKER ?? 'docker';
  const database = fixture(220), admin = fixture(221), adminPassword = fixture(223), user = fixture(222), password = fixture(224);
  for (const secret of [adminPassword, password, user]) registerPrivate(secret);
  const run = (args, options = {}) => command(docker, args, { signal, ...options });
  let id, name, port, imageId;
  const sql = (statement, { writer = false, expected = 0 } = {}) => run(['exec', '--interactive', '--env', 'PGPASSWORD=' + (writer ? password : adminPassword), id,
    'psql', '--no-psqlrc', '--host=127.0.0.1', '--username', writer ? user : admin, '--dbname', database,
    '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--set', 'VERBOSITY=sqlstate'], { input: statement + '\n', timeout: 12000, expected });
  return {
    secrets: [adminPassword, password, user], sql,
    connection: () => ({ host: '127.0.0.1', port, database, user, password, ssl: false }),
    get imageId() { return imageId; },
    async start() {
      await run(['pull', '--quiet', 'postgres:17'], { timeout: 240000 });
      name = 'synthetic-crank-write-' + randomUUID();
      id = (await run(['create', '--name', name, '--memory', '512m', '--cpus', '1', '--publish', '127.0.0.1::5432',
        '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=256m', '--env', 'POSTGRES_USER=' + admin,
        '--env', 'POSTGRES_PASSWORD=' + adminPassword, '--env', 'POSTGRES_DB=' + database, 'postgres:17'])).stdout.trim();
      assert.match(id, /^[a-f0-9]{64}$/);
      await run(['start', id]);
      const published = (await run(['port', id, '5432/tcp'])).stdout.trim();
      assert.match(published, /^127\.0\.0\.1:\d+$/); port = Number(published.split(':')[1]);
      const deadline = Date.now() + 120000;
      while ((await sql('SELECT 1;', { expected: null })).code !== 0) {
        if (Date.now() >= deadline) throw new Error('Owned PostgreSQL write fixture did not become ready.');
        await delay(500, undefined, { signal });
      }
      imageId = (await run(['inspect', '--format', '{{.Image}}', id])).stdout.trim();
      await sql(`CREATE TABLE public.write_stock(name text PRIMARY KEY,quantity integer NOT NULL);
        CREATE TABLE public.write_effects(name text NOT NULL,quantity integer NOT NULL);
        INSERT INTO public.write_stock VALUES ('${fixture(241)}',24);
        CREATE FUNCTION public.record_write_effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
          BEGIN INSERT INTO public.write_effects VALUES (NEW.name,NEW.quantity); RETURN NEW; END $$;
        CREATE TRIGGER record_write_effect AFTER INSERT OR UPDATE ON public.write_stock FOR EACH ROW EXECUTE FUNCTION public.record_write_effect();
        CREATE TABLE public.write_receipts(operation_key text PRIMARY KEY,binding_digest text NOT NULL,input_digest text NOT NULL,output_json jsonb);
        CREATE USER "${user}" PASSWORD '${password}';
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC;
        REVOKE ALL ON FUNCTION public.record_write_effect() FROM PUBLIC;
        GRANT CONNECT ON DATABASE "${database}" TO "${user}";
        GRANT USAGE ON SCHEMA public TO "${user}";
        GRANT SELECT,INSERT ON public.write_stock TO "${user}";
        GRANT UPDATE(quantity) ON public.write_stock TO "${user}";
        GRANT SELECT,INSERT,UPDATE ON public.write_receipts TO "${user}";`);
      const refused = await sql('DELETE FROM public.write_stock;', { writer: true, expected: null });
      assert.notEqual(refused.code, 0); assert.match(refused.stderr, /42501/);
    },
    async close() {
      if (!id && name) {
        const found = await command(docker, ['inspect', '--type=container', '--format', '{{.Id}}', name], { expected: null });
        if (!found.code) { id = found.stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/); }
        else if (!/No such (object|container)/i.test(found.stderr)) throw new Error('Owned PostgreSQL container cleanup could not locate its create.');
      }
      if (id) await command(docker, ['rm', '--force', '--volumes', id], { timeout: 30000 });
    },
  };
}
