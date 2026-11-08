import { DoorError } from '../protocol.ts';

export type IntakeFormat = 'csv' | 'ndjson' | 'json';
export interface ImportDoorIntake {
  readonly formats: readonly IntakeFormat[];
  readonly allow: Readonly<Partial<Record<IntakeFormat, readonly string[]>>>;
}
export interface IntakeLimits {
  readonly maxBytes: number;
  readonly maxRecordBytes: number;
  readonly maxRecords: number;
}

export function malformed(row: number, reason: string): never {
  throw new DoorError('intake_malformed_row', 422, { row, reason });
}
export function tooLarge(code: 'intake_too_large' | 'intake_record_too_large' | 'intake_too_many_records', row: number): never {
  throw new DoorError(code, 413, { row });
}
export function utf8Length(char: string): number {
  const point = char.codePointAt(0)!;
  return point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
}
export interface IntakeParser {
  readonly row: number;
  push(char: string): string | undefined;
  finish(): string | undefined;
}
