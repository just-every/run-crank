export const archiveMigrationModule: string
export function archiveMigrationSource(extraMigrations?: { name: string; sql: string }[], watch?: (path: URL) => void): Promise<string>
export function archiveMigrationsPlugin(): import('vite').Plugin
