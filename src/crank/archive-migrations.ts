import history from 'virtual:crank-archive-migrations'
import { destinationLedger, matchMigrationLedger } from '@runeditrun/rer/internal/modules/portability/ledgers.mjs'
import { PortabilityError, type MigrationReplay } from '@runeditrun/rer/internal/modules/portability/index.mjs'

// Only destination-owned migration files and the destination's applied ledger
// select replay evidence. The shared importer verifies the live schema, places
// the archive in this history and decides whether later changes are additive.
export async function archiveMigrations(db: D1Database): Promise<MigrationReplay> {
  const names = matchMigrationLedger(await destinationLedger(db) ?? [], history.files)
  const selected = history.files.filter(file => names.includes(file.name))
  return { names,
    statements: name => selected.find(file => file.name === name)!.statements,
    sha256: name => selected.find(file => file.name === name)?.sha256,
    async schemaAfter(chosen, options: { tablesOnly?: boolean; legacyExcludedObjects?: boolean } = {}) {
      const ordered = history.files.filter(file => chosen.includes(file.name)).map(file => file.name)
      const schemas = history.schemas[JSON.stringify(ordered)]
      if (ordered.length !== chosen.length || !schemas) throw new PortabilityError('schema_mismatch')
      return schemas[options.tablesOnly ? 1 : options.legacyExcludedObjects ? 2 : 0]
    },
  }
}
