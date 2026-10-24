// SQLite's complete-statement state machine recognizes trigger terminators as
// ; END ;, so CASE ... END and quoted/commented semicolons cannot end a trigger.
// https://github.com/sqlite/sqlite/blob/master/src/complete.c (public domain)
const transitions = [
  [1, 0, 2, 3, 4, 2, 2, 2],
  [1, 1, 2, 3, 4, 2, 2, 2],
  [1, 2, 2, 2, 2, 2, 2, 2],
  [1, 3, 3, 2, 4, 2, 2, 2],
  [1, 4, 2, 2, 2, 4, 5, 2],
  [6, 5, 5, 5, 5, 5, 5, 5],
  [6, 6, 5, 5, 5, 5, 5, 7],
  [1, 7, 5, 5, 5, 5, 5, 5],
];
const keywords = {EXPLAIN: 3, CREATE: 4, TEMP: 5, TEMPORARY: 5, TRIGGER: 6, END: 7};
const identifier = /[\w$\u0080-\uffff]/;

/** Return executable statements, retaining quoted values and comments verbatim. */
export function splitSqlStatements(sql) {
  const statements = [];
  let state = 0, start = 0, hasSql = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i], next = sql[i + 1];
    let token = 2;
    if (/\s/.test(char)) continue;
    if (char === '-' && next === '-') {
      while (i + 1 < sql.length && sql[i + 1] !== '\n') i++;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated SQL comment');
      i = end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      let closed = false;
      while (++i < sql.length) if (sql[i] === close) {
        if (close !== ']' && sql[i + 1] === close) { i++; continue; }
        closed = true;
        break;
      }
      if (!closed) throw new Error('Unterminated SQL quote');
    } else if (char === ';') token = 0;
    else if (identifier.test(char)) {
      const wordStart = i;
      while (i + 1 < sql.length && identifier.test(sql[i + 1])) i++;
      token = keywords[sql.slice(wordStart, i + 1).toUpperCase()] ?? 2;
    }
    if (token !== 0) hasSql = true;
    state = transitions[state][token];
    if (state === 1) {
      if (hasSql) statements.push(sql.slice(start, i + 1).trim());
      start = i + 1;
      hasSql = false;
      state = 0;
    }
  }
  if (hasSql) {
    if (state === 5 || state === 6) throw new Error('Unterminated SQL trigger');
    statements.push(`${sql.slice(start).trim()}\n;`);
  }
  return statements;
}
