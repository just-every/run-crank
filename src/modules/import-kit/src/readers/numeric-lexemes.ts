import type { ApiPageContext, ApiSourceInput, Json, JsonPathSegment, SourceLocation } from '../types.ts';
import { checkAbort, fail } from './errors.ts';
import { parseJson } from './json.ts';
import { safeValue } from './records.ts';
import { reflectedNumberCredentialMatcher } from '../provenance/numeric-credentials.ts';

interface NumberToken { start: number; end: number; path: JsonPathSegment[] }
export const EMPTY_API_PAGE_CONTEXT: ApiPageContext = Object.freeze({ numericLexemes: Object.freeze(Object.create(null)) });

/** Walk validated JSON syntax, never string contents, to locate numeric value tokens. */
function numberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  let index = 0;
  const whitespace = () => { while (' \t\r\n'.includes(text[index]) && index < text.length) index++; };
  const stringEnd = () => {
    index++; // opening quote
    while (text[index] !== '"') { if (text[index] === '\\') index++; index++; }
    index++;
  };
  const visit = (path: JsonPathSegment[]): void => {
    whitespace();
    const character = text[index];
    if (character === '"') { stringEnd(); return; }
    if (character === '{' || character === '[') {
      const object = character === '{', close = object ? '}' : ']';
      index++; whitespace();
      let arrayIndex = 0;
      while (text[index] !== close) {
        let key: JsonPathSegment = arrayIndex++;
        if (object) {
          const start = index;
          stringEnd();
          key = JSON.parse(text.slice(start, index)) as string;
          whitespace(); index++; // colon
        }
        visit([...path, key]); whitespace();
        if (text[index] !== ',') break;
        index++; whitespace();
      }
      index++; return;
    }
    const start = index;
    while (index < text.length && !' \t\r\n,]}'.includes(text[index])) index++;
    if (character === '-' || (character >= '0' && character <= '9')) tokens.push({ start, end: index, path });
  };
  visit([]);
  return tokens;
}

function withStrings(text: string, tokens: readonly NumberToken[]): Json {
  const parts: string[] = [];
  let offset = 0;
  for (const token of tokens) {
    parts.push(text.slice(offset, token.start), '"', text.slice(token.start, token.end), '"');
    offset = token.end;
  }
  parts.push(text.slice(offset));
  return JSON.parse(parts.join('')) as Json;
}

/** Security validation precedes both callbacks; original bytes remain owned by the reader. */
export function parseApiJson(text: string, location: SourceLocation, secrets: readonly string[], input: ApiSourceInput): { value: Json; context: ApiPageContext } {
  const original = parseJson(text, location); // syntax and duplicate-key validation, including escaped keys
  const preserve = input.preserveNumberLexeme;
  const tokens = preserve !== undefined || secrets.length ? numberTokens(text) : [];
  const reflectsNumber = reflectedNumberCredentialMatcher(secrets);
  // The original lexeme can retain digits lost by Number rounding, even when the
  // adapter does not select numeric preservation or excludes this field entirely.
  for (const token of tokens) {
    if (reflectsNumber(text.slice(token.start, token.end))) fail('CREDENTIAL_IN_SOURCE_DATA', location);
  }
  if (preserve === undefined) {
    safeValue(original, secrets, location, input.paginationCursorPolicy);
    return { value: original, context: EMPTY_API_PAGE_CONTEXT };
  }
  // Validate decoded keys/strings and exact numeric text before exposing even paths.
  // Strings permit valid overflowing JSON numbers here; unselected numbers must still
  // pass the ordinary finite-value check below.
  safeValue(withStrings(text, tokens), secrets, location, input.paginationCursorPolicy);
  const selected: NumberToken[] = [];
  const numericLexemes: Record<string, string> = Object.create(null);
  for (const token of tokens) {
    checkAbort(input.signal);
    let keep: unknown;
    try { keep = preserve(Object.freeze([...token.path])); }
    catch { fail('SOURCE_NUMBER_POLICY_FAILED', location); }
    if (typeof keep !== 'boolean') {
      // Invalid async policies must not leak a rejected promise's private cause.
      void Promise.resolve(keep).catch(() => {});
      fail('SOURCE_NUMBER_POLICY_FAILED', location);
    }
    checkAbort(input.signal);
    if (keep) {
      selected.push(token);
      const pointer = token.path.map(part => '/' + String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('');
      numericLexemes[pointer] = text.slice(token.start, token.end);
    }
  }
  const value = withStrings(text, selected);
  const context = Object.freeze({ numericLexemes: Object.freeze(numericLexemes) });
  safeValue(value, secrets, location, input.paginationCursorPolicy);
  safeValue(context, secrets, location, input.paginationCursorPolicy);
  return { value, context };
}
