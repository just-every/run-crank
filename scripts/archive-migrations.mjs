import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';
import { migrationReplay } from '@runeditrun/rer/internal/modules/portability/migration-history.mjs';
import { migrationStatements } from '@runeditrun/rer/internal/modules/portability/migration-sql.mjs';
import { createRequire } from 'node:module';
import policy from '../src/crank/archive-policy.mjs';

export const archiveMigrationModule = fileURLToPath(new URL('../src/crank/archive-migration-history.ts', import.meta.url));
const historicalSchemas = new Map();
const directory = new URL('../migrations/core/', import.meta.url);
const cache = new URL('../.cache/archive-migrations/', import.meta.url);
const rerVersion = createRequire(import.meta.url)('@runeditrun/rer/package.json').version;

// Workers cannot open Node's scratch SQLite database. Run the CLI's replayer
// while bundling instead, retaining its identities and statements for every
// historical prefix. No archive SQL is executed or generated source committed.
// Cache by all replay inputs so separate test processes do not each rebuild the
// same history. A migration/policy/tool/runtime change selects a fresh cache.
export async function archiveMigrationSource(extraMigrations = [], watch = () => {}) {
  const plan = [];
  watch(directory);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const path = new URL(name, directory);
    watch(path);
    plan.push({ name, sql: await readFile(path, 'utf8') });
  }
  plan.push(...extraMigrations);
  const files = plan.map(({ name, sql }) => ({ name,
    sha256: createHash('sha256').update(sql).digest('hex'),
    statements: migrationStatements(sql, unstable_splitSqlQuery),
  }));
  const key = createHash('sha256').update(JSON.stringify({ files, policy, rerVersion, sqlite: process.versions.sqlite }))
    .update(await readFile(new URL(import.meta.url))).digest('hex');
  const cached = new URL(key + '.mjs', cache);
  try { return await readFile(cached, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const replay = migrationReplay(files, policy), schemas = {};
  for (let length = 0; length <= files.length; length++) {
    const names = replay.names.slice(0, length);
    const key = JSON.stringify(files.slice(0, length).map(({ name, sha256 }) => [name, sha256]));
    if (!historicalSchemas.has(key)) historicalSchemas.set(key, Promise.all([
      replay.schemaAfter(names),
      replay.schemaAfter(names, { tablesOnly: true }),
      replay.schemaAfter(names, { legacyExcludedObjects: true }),
    ]));
    schemas[JSON.stringify(names)] = await historicalSchemas.get(key);
  }
  // Discover column requests from the destination's own SQL, then let the
  // shared replayer produce the exact row images used for empty-target checks.
  const scratch = new DatabaseSync(':memory:');
  let requests;
  const quote = name => '"' + name.replaceAll('"', '""') + '"';
  try {
    for (const file of files) for (const sql of file.statements) scratch.exec(sql);
    requests = scratch.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map(({ name }) => ({ name, columns: scratch.prepare(`PRAGMA table_info(${quote(name)})`).all().map(column => column.name) }));
  } finally { scratch.close(); }
  const images = await replay.rowImages(requests, 10000);
  const seeds = requests.filter(request => images.has(request.name))
    .map(request => ({ ...request, images: images.get(request.name) }));
  const source = `export default ${JSON.stringify({ files, schemas, seeds })};`;
  await mkdir(cache, { recursive: true });
  const pending = new URL(key + '.' + process.pid + '.new', cache);
  await writeFile(pending, source);
  await rename(pending, cached);
  return source;
}

export function archiveMigrationsPlugin() {
  const id = archiveMigrationModule;
  return { name: 'crank-archive-migrations',
    async load(source) {
      if (source === id) return archiveMigrationSource([], path => this.addWatchFile(fileURLToPath(path)));
    },
  };
}
