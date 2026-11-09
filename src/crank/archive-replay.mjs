import initSqlJs from 'sql.js/dist/sql-asm.js';
import { policy, schemaIdentity } from '@runeditrun/rer/internal/modules/portability/catalogue.mjs';
import { PortabilityError } from '@runeditrun/rer/internal/modules/portability/index.mjs';
import archivePolicy from './archive-policy.mjs';

// The Worker has no node:sqlite. Use an in-memory JS SQLite engine to run the
// same ordered, destination-owned statements as the CLI's migrationReplay.
// No archive SQL, product database or network is involved in this replay.
export async function replayArchiveSchema(files, options) {
  const SQL = await initSqlJs();
  const scratch = new SQL.Database();
  const db = {
    prepare(sql) {
      return {
        async all() {
          const query = scratch.prepare(sql);
          try {
            const results = [];
            while (query.step()) results.push(query.getAsObject());
            return { results };
          } finally { query.free(); }
        },
      };
    },
  };
  try {
    for (const file of files) for (const sql of file.statements) scratch.run(sql);
    return await schemaIdentity(db, policy(archivePolicy), options);
  } catch {
    throw new PortabilityError('schema_mismatch');
  } finally { scratch.close(); }
}
