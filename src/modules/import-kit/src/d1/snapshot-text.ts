import { Buffer } from 'node:buffer';

type Piece = string | { value: string };

/** Split JSON text at value tokens, retaining its original lexical bytes.
 * Keys, whitespace, number spelling and escaping are never reserialized. */
function textPieces(text: string): Piece[] {
  try { JSON.parse(text); } catch { return [{ value: JSON.stringify(text) }]; }
  const pieces: Piece[] = ['"'];
  const escape = (value: string) => JSON.stringify(value).slice(1, -1);
  let position = 0;
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const end = match.index + match[0].length;
    if (/^\s*:/.test(text.slice(end))) continue;
    pieces.push(escape(text.slice(position, match.index)), { value: escape(match[0]) });
    position = end;
  }
  pieces.push(escape(text.slice(position)), '"');
  return pieces;
}

/** A chunk-local template dictionary for exact row snapshots. Repeated JSON
 * structure and identical evidence travel once; unique values remain literal
 * text slices. SQLite concatenates those slices, never interprets them as SQL
 * or regenerates the JSON whose exact bytes the guard must compare. */
export function snapshotText(rows: unknown[][]): string {
  const pieces = rows.map(row => row.flatMap((value, index): Piece[] => [
    index ? ',' : '[',
    ...(typeof value === 'string' && /^\s*[\[{]/.test(value) ? textPieces(value) : [{ value: JSON.stringify(value) ?? 'null' }]),
    ...index === row.length - 1 ? [']'] : [],
  ]));
  const counts = new Map<string, number>();
  for (const row of pieces) for (const piece of row) if (typeof piece !== 'string') counts.set(piece.value, (counts.get(piece.value) ?? 0) + 1);
  const templates: (string | number)[][] = [], known = new Map<string, number>();
  const encoded = pieces.map(row => {
    const template: (string | number)[] = [], values: string[] = [], slots = new Map<string, number>();
    const literal = (text: string) => {
      if (typeof template.at(-1) === 'string') template[template.length - 1] = String(template.at(-1)) + text;
      else template.push(text);
    };
    for (const piece of row) {
      if (typeof piece === 'string') literal(piece);
      else if (counts.get(piece.value)! > rows.length / 2) literal(piece.value);
      else {
        let slot = slots.get(piece.value);
        if (slot === undefined) { slot = values.length + 1; slots.set(piece.value, slot); values.push(piece.value); }
        template.push(slot);
      }
    }
    const key = JSON.stringify(template);
    let index = known.get(key);
    if (index === undefined) { index = templates.length; known.set(key, index); templates.push(template); }
    return [index, ...values];
  });
  return JSON.stringify([templates, encoded]);
}

export const snapshotTextRows = `WITH snapshot(body) AS (SELECT ?), decoded(value) AS MATERIALIZED (
  SELECT (SELECT group_concat(piece,'') FROM (
    SELECT CASE WHEN p.type='integer' THEN json_extract(r.value,'$['||p.value||']') ELSE p.value END AS piece
    FROM json_each(snapshot.body,'$[0]['||json_extract(r.value,'$[0]')||']') p ORDER BY CAST(p.key AS INTEGER)
  )) FROM snapshot,json_each(snapshot.body,'$[1]') r
) SELECT 1 FROM decoded e`;

// Include JSON escaping in the choice, as the binding itself is a JSON string
// in D1's request. Small snapshots keep the simpler direct representation.
export const snapshotTextSaves = (plain: string, encoded: string): boolean =>
  Buffer.byteLength(JSON.stringify(encoded)) + Buffer.byteLength(snapshotTextRows) < Buffer.byteLength(JSON.stringify(plain));
