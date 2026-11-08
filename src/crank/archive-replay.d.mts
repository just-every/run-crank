export function replayArchiveSchema(
  files: { statements: string[] }[],
  options?: { tablesOnly?: boolean; legacyExcludedObjects?: boolean },
): Promise<string>
