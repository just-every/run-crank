import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';
import { migrationReplay } from '@runeditrun/rer/internal/modules/portability/migration-history.mjs';
import { migrationStatements } from '@runeditrun/rer/internal/modules/portability/migration-sql.mjs';
import policy from '../src/crank/archive-policy.mjs';

export const archiveMigrationModule = 'virtual:crank-archive-migrations';
const historicalSchemas = new Map();
const directory = new URL('../migrations/core/', import.meta.url);

// Workers cannot open Node's scratch SQLite database. Run the CLI's replayer
// while bundling instead, retaining its identities and statements for every
// historical prefix. No archive SQL is executed and no generated source is kept.
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
  return `export default ${JSON.stringify({ files, schemas })};`;
}

export function archiveMigrationsPlugin() {
  const id = '\0' + archiveMigrationModule;
  return { name: 'crank-archive-migrations',
    resolveId(source) { if (source === archiveMigrationModule) return id; },
    async load(source) {
      if (source === id) return archiveMigrationSource([], path => this.addWatchFile(path.pathname));
    },
  };
}
