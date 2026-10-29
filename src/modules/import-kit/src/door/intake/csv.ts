import { malformed, tooLarge, utf8Length, type IntakeLimits, type IntakeParser } from './types.ts';

/** RFC 4180 cells, projected only after a complete row passes width checks. */
export class CsvIntake implements IntakeParser {
  private state: 'start' | 'bare' | 'quoted' | 'closed' = 'start';
  private cell = '';
  private cells: string[] = [];
  private headers: string[] | undefined;
  private readonly allowed: Set<string>;
  private size = 0;
  private line = 1;
  private count = 0;
  private skipLf = false;
  private readonly limits: IntakeLimits;
  constructor(fields: readonly string[], limits: IntakeLimits) { this.limits = limits; this.allowed = new Set(fields); }
  get row(): number { return this.line; }
  push(char: string): string | undefined {
    if (this.skipLf) {
      this.skipLf = false;
      if (char === '\n') return;
    }
    this.size += utf8Length(char);
    if (this.size > this.limits.maxRecordBytes) tooLarge('intake_record_too_large', this.row);
    if (this.state === 'quoted') {
      if (char === '"') this.state = 'closed';
      else this.cell += char;
      return;
    }
    if (char === '"') {
      if (this.state === 'start') this.state = 'quoted';
      else if (this.state === 'closed') { this.cell += '"'; this.state = 'quoted'; }
      else malformed(this.row, 'invalid_csv');
      return;
    }
    if (char === ',') { this.endCell(); return; }
    if (char === '\r' || char === '\n') {
      this.skipLf = char === '\r';
      const output = this.record();
      this.line++;
      return output;
    }
    if (this.state === 'closed') malformed(this.row, 'invalid_csv');
    this.cell += char;
    this.state = 'bare';
  }
  private endCell(): void {
    this.cells.push(this.cell);
    this.cell = ''; this.state = 'start';
  }
  private record(): string | undefined {
    this.endCell();
    const cells = this.cells;
    this.cells = []; this.size = 0;
    if (!this.headers) {
      if (new Set(cells).size !== cells.length) malformed(this.row, 'duplicate_header');
      this.headers = cells;
      return;
    }
    if (cells.length !== this.headers.length) malformed(this.row, 'width_mismatch');
    if (this.count >= this.limits.maxRecords) tooLarge('intake_too_many_records', this.row);
    this.count++;
    const output: string[] = [];
    for (let index = 0; index < cells.length; index++) {
      const key = this.headers[index];
      if (this.allowed.has(key)) output.push(`${JSON.stringify(key)}:${JSON.stringify(cells[index])}`);
    }
    return `{${output.join(',')}}`;
  }
  finish(): string | undefined {
    if (this.state === 'quoted') malformed(this.row, 'invalid_csv');
    if (!this.size) return;
    return this.record();
  }
}
