/** The clause-ID rule as a regular-expression source, shared with the release catalogue. */
export const clauseIdSource: string
export type ClauseKind = 'published' | 'target' | 'push-further'
export type ClauseStatus = 'done' | 'partial' | 'missing'

/** One row of the Status table, joined to the clause it judges. */
export interface ContractClause {
  /** "HOME-001". */
  id: string
  /** The clause title, as defined and as the row gives it: "Public landing". */
  title: string
  kind: ClauseKind
  status: ClauseStatus
  /** Repository paths backing a done or partial row, from the Evidence cell's backticks. */
  evidence: string[]
  /** What is missing, for a partial or missing row; may be empty for a done row. */
  gap: string
  /** The heading the clause is defined under: "Public landing", "Writing together". */
  area: string
  /** The clause's prose as one line: the rest of its definition line and the lines below it; may be empty. */
  text: string
  /** The 1-based CONTRACT.md line that defines the clause. */
  line: number
  /** The 1-based CONTRACT.md line of its Status row. */
  row: number
}

/** A heading clauses are defined under, with the tally of its rows. */
export interface ContractArea {
  /** "Archive, trash and deletion". */
  name: string
  /** Its anchor on /contract: "archive-trash-and-deletion". */
  slug: string
  /** "target" under a "Target clauses" or "Push further" heading, else "published". */
  group: 'published' | 'target'
  /** Its clause IDs in the order the contract defines them. */
  clauses: string[]
  done: number
  partial: number
  missing: number
  total: number
}

export interface SeedContract {
  /** The commit the statuses were judged at: "8956e45". */
  commit: string
  /** The judged-at date as YYYY-MM-DD. */
  date: string
  /**
   * From the "## Product target" table: `replaces` is the Incumbents cell in
   * full and `incumbents` its names; `alsoBeats` is the "… must also beat" row,
   * null when the table has none.
   */
  target: { category: string; incumbents: string[]; replaces: string; alsoBeats: string | null; firstBuyer: string }
  /** Areas in the order the contract defines them. */
  areas: ContractArea[]
  /** Every clause, in Status table order. */
  clauses: ContractClause[]
  counts: { done: number; partial: number; missing: number; total: number }
}

export interface ContractProblem { line: number; message: string }

export class ContractError extends Error {
  file: string
  problems: ContractProblem[]
  constructor(file: string, problems: ContractProblem[])
}

export const kinds: readonly ClauseKind[]
export const statuses: readonly ClauseStatus[]
export const statusHeader: readonly string[]
export function plainText(value: string): string
export function areaSlug(name: string): string
/** Parse CONTRACT.md; throws a ContractError naming the line of every problem. */
export function parseContract(text: string, options?: { file?: string }): SeedContract
