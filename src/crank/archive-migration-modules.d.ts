declare module 'virtual:crank-archive-migrations' {
  const history: {
    files: { name: string; sha256: string; statements: string[] }[]
    schemas: Record<string, [string, string, string]>
  }
  export default history
}

declare module '@runeditrun/rer/internal/modules/portability/ledgers.mjs' {
  interface Entry { name: string; sha256?: string }
  export function destinationLedger(db: D1Database): Promise<Entry[] | undefined>
  export function matchMigrationLedger(entries: Entry[], files: Entry[]): string[]
}
