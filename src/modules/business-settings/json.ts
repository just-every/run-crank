import { SettingsError } from './types.ts';

/** Parse UTF-8 JSON without accepting duplicate or escaped-alias object members. */
export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  let position = 0;
  const whitespace = () => { while (position < text.length && /\s/.test(text[position])) position++; };
  function stringToken(): string {
    const start = position++;
    while (position < text.length) {
      const c = text[position++];
      if (c === '\\') position++;
      else if (c === '"') return JSON.parse(text.slice(start, position)) as string;
    }
    throw new SettingsError('invalid_settings');
  }
  function visit(depth: number): void {
    if (depth > 16) throw new SettingsError('invalid_settings');
    whitespace();
    const opening = text[position];
    if (opening === '"') { stringToken(); return; }
    if (opening !== '{' && opening !== '[') {
      while (position < text.length && !/[\s,}\]]/.test(text[position])) position++;
      return;
    }
    position++; whitespace();
    const closing = opening === '{' ? '}' : ']', names = new Set<string>();
    if (text[position] === closing) { position++; return; }
    for (;;) {
      if (opening === '{') {
        whitespace(); const key = stringToken();
        if (names.has(key)) throw new SettingsError('invalid_settings');
        names.add(key); whitespace(); position++;
      }
      visit(depth + 1); whitespace();
      if (text[position++] === closing) return;
    }
  }
  visit(0);
  return value;
}
