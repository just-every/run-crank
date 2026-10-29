import { malformed, tooLarge, utf8Length, type IntakeLimits, type IntakeParser } from './types.ts';

interface Selection { leaf: boolean; children: Map<string, Selection> }
function selection(fields: readonly string[]): Selection {
  const root: Selection = { leaf: false, children: new Map() };
  for (const pointer of fields) {
    let node = root;
    for (const key of pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      let child = node.children.get(key);
      if (!child) node.children.set(key, child = { leaf: false, children: new Map() });
      node = child;
    }
    node.leaf = true;
  }
  return root;
}

/** Validate the entire record, including discarded subtrees. Retain scalar tokens
 * verbatim so integers and decimal lexemes never pass through JS numbers. */
export function jsonProjection(fields: readonly string[]): (source: string, row: number) => string {
  const selected = selection(fields);
  return (source, row) => {
    let at = 0;
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    const fail = (reason = 'invalid_json'): never => malformed(row, reason);
    const space = () => { while (/[\x20\t\r\n]/.test(source[at] ?? '') && at < source.length) at++; };
    function string(): string {
      const start = at++;
      while (at < source.length) {
        const char = source[at++];
        if (char === '"') {
          const token = source.slice(start, at);
          try { JSON.parse(token); } catch { fail(); }
          return token;
        }
        if (char === '\\') at++;
        else if (char.charCodeAt(0) < 0x20) fail();
      }
      return fail();
    }
    function value(node: Selection | undefined, depth: number): string | undefined {
      if (depth > 64) fail('max_depth');
      space();
      const first = source[at];
      if (first === '{') {
        if (node?.leaf) fail('leaf_not_scalar');
        at++; space();
        const keys = new Set<string>(), output: string[] = [];
        if (source[at] !== '}') {
          for (;;) {
            if (source[at] !== '"') fail();
            const token = string(), key = JSON.parse(token) as string;
            if (keys.has(key)) fail('duplicate_key');
            keys.add(key); space();
            if (source[at++] !== ':') fail();
            const child = value(node?.children.get(key), depth + 1);
            if (child !== undefined) output.push(`${JSON.stringify(key)}:${child}`);
            space();
            if (source[at] === '}') break;
            if (source[at++] !== ',') fail();
            space();
          }
        }
        at++;
        return node && (output.length > 0 || depth === 0) ? `{${output.join(',')}}` : undefined;
      }
      if (first === '[') {
        if (node?.leaf) fail('leaf_not_scalar');
        if (node?.children.size) fail('unsupported_array_path');
        at++; space();
        if (source[at] !== ']') {
          for (;;) {
            value(undefined, depth + 1); space();
            if (source[at] === ']') break;
            if (source[at++] !== ',') fail();
          }
        }
        at++;
        return undefined;
      }
      const start = at;
      if (first === '"') string();
      else if (source.startsWith('true', at)) at += 4;
      else if (source.startsWith('false', at)) at += 5;
      else if (source.startsWith('null', at)) at += 4;
      else {
        number.lastIndex = at;
        const match = number.exec(source);
        if (!match) fail();
        at = number.lastIndex;
      }
      return node?.leaf ? source.slice(start, at) : undefined;
    }
    space();
    if (source[at] !== '{') fail('object_required');
    const output = value(selected, 0)!;
    space();
    if (at !== source.length) fail();
    return output;
  };
}

/** A plain array of object records. Only the current element is retained. */
export class JsonIntake implements IntakeParser {
  private state: 'start' | 'first' | 'next' | 'record' | 'separator' | 'done' = 'start';
  private source = '';
  private size = 0;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private count = 0;
  private readonly project: ReturnType<typeof jsonProjection>;
  private readonly limits: IntakeLimits;
  constructor(fields: readonly string[], limits: IntakeLimits) { this.limits = limits; this.project = jsonProjection(fields); }
  get row(): number { return this.count + 1; }
  push(char: string): string | undefined {
    if (this.state === 'record') {
      this.size += utf8Length(char);
      if (this.size > this.limits.maxRecordBytes) tooLarge('intake_record_too_large', this.row);
      this.source += char;
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.quoted = false;
      } else if (char === '"') this.quoted = true;
      else if (char === '{' || char === '[') {
        if (++this.depth > 65) malformed(this.row, 'max_depth');
      } else if (char === '}' || char === ']') {
        if (--this.depth === 0) {
          const output = this.project(this.source, this.row);
          this.source = ''; this.size = 0; this.count++; this.state = 'separator';
          return output;
        }
      }
      return;
    }
    if (/[\x20\t\r\n]/.test(char)) return;
    if (this.state === 'start' && char === '[') { this.state = 'first'; return; }
    if ((this.state === 'first' || this.state === 'separator') && char === ']') { this.state = 'done'; return; }
    if (this.state === 'separator' && char === ',') { this.state = 'next'; return; }
    if ((this.state === 'first' || this.state === 'next') && char === '{') {
      if (this.count >= this.limits.maxRecords) tooLarge('intake_too_many_records', this.row);
      this.size = 1;
      if (this.size > this.limits.maxRecordBytes) tooLarge('intake_record_too_large', this.row);
      this.state = 'record'; this.source = char; this.depth = 1; return;
    }
    malformed(this.row, 'invalid_json');
  }
  finish(): undefined {
    if (this.state !== 'done') malformed(this.row, 'invalid_json');
    return undefined;
  }
}

export class NdjsonIntake implements IntakeParser {
  private source = '';
  private size = 0;
  private line = 1;
  private count = 0;
  private readonly project: ReturnType<typeof jsonProjection>;
  private readonly limits: IntakeLimits;
  constructor(fields: readonly string[], limits: IntakeLimits) { this.limits = limits; this.project = jsonProjection(fields); }
  get row(): number { return this.line; }
  push(char: string): string | undefined {
    this.size += utf8Length(char);
    if (this.size > this.limits.maxRecordBytes) tooLarge('intake_record_too_large', this.row);
    if (char !== '\n') { this.source += char; return; }
    const output = this.record();
    this.line++;
    return output;
  }
  private record(): string | undefined {
    const source = this.source;
    this.source = ''; this.size = 0;
    if (/^[\x20\t\r]*$/.test(source)) return;
    if (this.count >= this.limits.maxRecords) tooLarge('intake_too_many_records', this.row);
    const output = this.project(source, this.row);
    this.count++;
    return output;
  }
  finish(): string | undefined { return this.record(); }
}
