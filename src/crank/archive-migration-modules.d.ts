declare module '@runeditrun/rer/internal/modules/portability/ledgers.mjs' {
  interface Entry { name: string; sha256?: string }
  export function destinationLedger(db: D1Database): Promise<Entry[] | undefined>
  export function matchMigrationLedger(entries: Entry[], files: Entry[]): string[]
}
