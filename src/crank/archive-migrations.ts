import bundledHistory from './archive-migration-history'
import { replayArchiveSchema } from './archive-replay.mjs'
import { destinationLedger, matchMigrationLedger } from '@runeditrun/rer/internal/modules/portability/ledgers.mjs'
import { PortabilityError, type MigrationReplay } from '@runeditrun/rer/internal/modules/portability/index.mjs'

// Only destination-owned migration files and the destination's applied ledger
// select replay evidence. The shared importer verifies the live schema, places
// the archive in this history and decides whether later changes are additive.
export async function archiveMigrations(db: D1Database): Promise<MigrationReplay & { rowImages(requests: { name: string; columns: string[] }[], limit: number): Promise<Map<string, string[]>> }> {
  const history = bundledHistory
  if (!history) throw new PortabilityError('schema_mismatch')
  const names = matchMigrationLedger(await destinationLedger(db) ?? [], history.files)
  const selected = names.map(name => history.files.find(file => file.name === name)!)
  return { names,
    statements: name => selected.find(file => file.name === name)!.statements,
    sha256: name => selected.find(file => file.name === name)?.sha256,
    async rowImages(requests, limit) {
      // Seed evidence is for the complete installed build. An older applied
      // prefix without row evidence remains occupied rather than being erased.
      if (selected.length !== history.files.length) return new Map()
      return new Map(requests.flatMap(request => {
        const seed = history.seeds.find(seed => seed.name === request.name && JSON.stringify(seed.columns) === JSON.stringify(request.columns))
        return seed && seed.images.length <= limit ? [[seed.name, seed.images] as [string, string[]]] : []
      }))
    },
    async schemaAfter(chosen, options: { tablesOnly?: boolean; legacyExcludedObjects?: boolean } = {}) {
      const ordered = selected.filter(file => chosen.includes(file.name))
      if (ordered.length !== chosen.length) throw new PortabilityError('schema_mismatch')
      const cached = history.schemas[JSON.stringify(ordered.map(file => file.name))]
      return cached
        ? cached[options.tablesOnly ? 1 : options.legacyExcludedObjects ? 2 : 0]
        : replayArchiveSchema(ordered, options)
    },
  }
}
