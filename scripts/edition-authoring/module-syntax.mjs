// Lex module syntax without treating comments, strings or template text as code.
// Template interpolations are code, including nested templates and import().
export function tokens(source) {
  const result = [];
  let i = 0;
  function quoted(quote) {
    const start = i++;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i++] === quote) break;
    }
    return source.slice(start, i);
  }
  function template() {
    const start = i++;
    let interpolated = false;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i] === '`') { i++; break; }
      if (source[i] === '$' && source[i + 1] === '{') {
        interpolated = true; i += 2; result.push(';'); scan(true); result.push(';');
      } else i++;
    }
    if (!interpolated) result.push(source.slice(start, i));
  }
  function scan(interpolation = false) {
    let braces = 0;
    while (i < source.length) {
      const c = source[i];
      if (/\s/.test(c)) { i++; continue; }
      if (source.startsWith('//', i)) {
        while (i < source.length && source[i] !== '\n') i++;
        continue;
      }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue;
      }
      if (c === "'" || c === '"') { result.push(quoted(c)); continue; }
      if (c === '`') { template(); continue; }
      if (interpolation && c === '}' && !braces) { i++; return; }
      if (c === '{') braces++;
      if (c === '}') braces--;
      if (/[\w$]/.test(c)) {
        const start = i++;
        while (i < source.length && /[\w$]/.test(source[i])) i++;
        result.push(source.slice(start, i));
      } else { result.push(c); i++; }
    }
  }
  scan(); return result;
}

export function unquote(value) {
  if (!/^['"`]/.test(value ?? '') || value[0] === '`' && value.includes('${')) return null;
  return value.slice(1, -1).replace(/\\(?:x([\da-fA-F]{2})|u(?:\{([\da-fA-F]+)\}|([\da-fA-F]{4}))|([\s\S]))/g,
    (_, x, codepoint, u, character) => x || codepoint || u ? String.fromCodePoint(parseInt(x ?? codepoint ?? u, 16)) : character === '\n' ? '' : ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v',0:'\0'}[character] ?? character));
}
