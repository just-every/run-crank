const wide = /[^\u0000-\u00ff]/;
const encoder = new TextEncoder();
const bytes = text => encoder.encode(text).byteLength;
const escaped = text => text.replace(/[^\u0000-\u00ff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
export const RPC_LIMIT = 32 * 1024 * 1024;

// SQLite parameter tokens, excluding quoted strings/identifiers and comments.
// Keep explicit indexes and repeated names: bind() addresses SQLite slots.
function parameters(sql) {
  const tokens = [], names = new Map(); let slot = 0;
  const pattern = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\?\d*|[:@$][\w\u0080-\uffff]+(?:::[\w\u0080-\uffff]+)*(?:\([^)]*\))?/g;
  for (const match of sql.matchAll(pattern)) {
    const token = match[0];
    if (!'?:@$'.includes(token[0])) continue;
    let index;
    if (token[0] === '?') index = token.length > 1 ? Number(token.slice(1)) : slot + 1;
    else { if (!names.has(token)) names.set(token, slot + 1); index = names.get(token); }
    slot = Math.max(slot, index);
    tokens.push({ start: match.index, end: match.index + token.length, index: index - 1 });
  }
  return tokens;
}

/** Keep wide bound text out of D1's single batch JSON string. JSON containers
 * passed directly to json_each can be escaped in place; other text is quoted
 * and decoded in SQLite. Stored values and transaction boundaries are unchanged.
 * Values whose encoding exceeds D1's bind ceiling remain native; rpcBytes then
 * accounts for their effect on the ENTIRE call, never just that parameter. */
function encodeSql(statement) {
  const { sql, params = [] } = statement;
  if (!params.some(value => typeof value === 'string' && wide.test(value))) return { sql, params };
  const tokens = parameters(sql), values = [...params], replacements = new Set();
  for (let index = 0; index < params.length; index++) {
    const value = params[index];
    if (typeof value !== 'string' || !wide.test(value)) continue;
    const uses = tokens.filter(token => token.index === index);
    if (!uses.length) continue;
    const json = uses.every(token => /\bjson_each\s*\(\s*$/i.test(sql.slice(0, token.start)));
    const encoded = escaped(json ? value : JSON.stringify(value));
    if (bytes(encoded) > 2_000_000) continue;
    values[index] = encoded;
    if (!json) replacements.add(index);
  }
  let query = '', position = 0;
  for (const token of tokens) {
    query += sql.slice(position, token.start);
    const original = sql.slice(token.start, token.end);
    query += replacements.has(token.index) ? `json_extract(${original},'$')` : original;
    position = token.end;
  }
  const result = { sql: query + sql.slice(position), params: values };
  // Encoding is a transport representation, never permission to exceed D1's
  // SQL budget. Each encoded value was checked against its bind ceiling above.
  // Native text remains an admissible choice;
  // the complete call below still accounts for its two-byte representation.
  if (bytes(result.sql) > 100_000) return { sql, params };
  return result;
}

// Weak keys retain work only while the caller retains a statement. Snapshots
// validate replaced arrays and in-place changes; mutable binding objects bypass
// reuse because their JSON representation can change without changing identity.
const representations = new WeakMap();
const primitive = value => value === null || !['object', 'function'].includes(typeof value);
function representation(statement) {
  const { sql, params = [] } = statement;
  if (typeof sql !== 'string' || !Array.isArray(params) || !params.every(primitive)) return { sql, params };
  const prior = representations.get(statement);
  if (prior && prior.sql === sql && prior.params.length === params.length && params.every((value, index) => Object.is(value, prior.params[index]))) return prior;
  const current = { sql, params: [...params] };
  representations.set(statement, current);
  return current;
}
const encoded = record => record.encoded ??= encodeSql(record);
function publicQuery(record, statement) {
  const query = encoded(record);
  // Public callers may mutate returned SQL and bindings. Never expose cached
  // encoded state; retain the native parameter alias when no encoding occurred.
  const result = { sql: query.sql, params: query.params === record.params ? statement.params ?? [] : [...query.params] };
  if (result.params.every(primitive)) representations.set(result, { sql: result.sql, params: [...result.params], rawSize: record.encodedSize });
  return result;
}
export function wireSql(statement) { return publicQuery(representation(statement), statement); }

/** A conservative size of D1's JSON request plus RPC envelope. A single wide
 * character makes workerd serialize every UTF-16 code unit in the call at two
 * bytes. UTF-8 also matters independently for provider payload limits. */
function contribution(statement) {
  let utf8 = 0, units = 0, hasWide = false;
  const add = text => { utf8 += bytes(text); units += text.length; hasWide ||= wide.test(text); };
  add('{"sql":' + JSON.stringify(statement.sql) + ',"params":[');
  for (const value of statement.params ?? []) {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      // D1 sends binary bindings as numeric arrays. Four bytes per element is
      // conservative and avoids constructing a second large byte array.
      const size = 3 + value.byteLength * 4; utf8 += size; units += size;
    } else add(JSON.stringify(value) + ',');
  }
  add(']},');
  return { utf8, units, hasWide };
}
function combined(records, encode = false) {
  let utf8 = 2, units = 2, hasWide = false;
  for (const record of records) {
    let size;
    if (encode) {
      const query = encoded(record);
      size = record.encodedSize ??= query.params === record.params ? record.rawSize ??= contribution(record) : contribution(query);
    } else size = record.rawSize ??= contribution(record);
    utf8 += size.utf8; units += size.units; hasWide ||= size.hasWide;
  }
  return { utf8, units, hasWide };
}
export function rpcSize(statements) { return combined(statements.map(representation)); }
export const rpcSizeBytes = ({ utf8, units, hasWide }) => 4096 + Math.max(utf8, units * (hasWide ? 2 : 1));
export const rpcBytes = statements => rpcSizeBytes(rpcSize(statements));

function selectBatch(statements) {
  const records = statements.map(representation), queries = records.map(encoded);
  const nativeBytes = rpcSizeBytes(combined(records)), encodedBytes = rpcSizeBytes(combined(records, true));
  // Dense CJK may be smaller as native two-byte text than as six-byte escapes.
  // One wide value affects the complete call; ties retain encoded selection.
  return nativeBytes < encodedBytes ? { queries: statements, bytes: nativeBytes, encoded: false, records } : { queries, bytes: encodedBytes, encoded: true, records };
}
export function wireBatch(statements) {
  const selection = selectBatch(statements);
  return selection.encoded ? selection.records.map((record, index) => publicQuery(record, statements[index])) : statements;
}
function sameQuery(left, right) {
  const a = left.params ?? [], b = right.params ?? [];
  return left.sql === right.sql && a.length === b.length && a.every((value, index) => primitive(value) && Object.is(value, b[index]));
}

/** Adapt only D1's prepare/batch boundary; native statements supplied by a
 * caller remain usable (e.g. an erasure batch shared with product mutations). */
export function wireDatabase(db) {
  const statements = new WeakMap();
  const prepare = (sql, params = []) => {
    const original = { sql, params }, selection = selectBatch([original]), query = selection.queries[0];
    const native = params.length ? db.prepare(query.sql).bind(...query.params) : db.prepare(sql);
    const wrapped = new Proxy(native, { get(target, key) {
      if (key === 'bind') return (...values) => prepare(sql, values);
      const value = target[key];
      if (['all', 'first', 'run', 'raw'].includes(key) && typeof value === 'function') return (...args) => {
        if (rpcBytes([query]) > RPC_LIMIT) throw new Error('D1_RPC_TRANSPORT_LIMIT');
        return value.apply(target, args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    statements.set(wrapped, { native, query: { sql: query.sql, params: [...query.params] }, original });
    return wrapped;
  };
  return new Proxy(db, { get(target, key) {
    if (key === 'prepare') return prepare;
    if (key === 'batch') return members => {
      const known = members.map(member => statements.get(member));
      const selection = selectBatch(known.filter(Boolean).map(member => member.original));
      const queries = selection.queries;
      if (selection.bytes > RPC_LIMIT) throw new Error('D1_RPC_TRANSPORT_LIMIT');
      let index = 0;
      return db.batch(members.map((member, i) => {
        if (!known[i]) return member;
        const query = queries[index++];
        if (sameQuery(query, known[i].query)) return known[i].native;
        return query.params?.length ? db.prepare(query.sql).bind(...query.params) : db.prepare(query.sql);
      }));
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
