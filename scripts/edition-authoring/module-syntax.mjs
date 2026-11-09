import {parse} from './vendor/babel-parser/babel-parser/index.mjs';

// Let the maintained parser distinguish strings, regex literals and template
// text. Keep raw token spelling for the conservative binding/export checks.
export function tokens(source, filename = 'module.ts') {
  const plugins = ['decorators-legacy', 'deprecatedImportAssert'];
  if (/\.[cm]?tsx?$/.test(filename)) plugins.push(['typescript', {dts: /\.d\.[cm]?ts$/.test(filename)}]);
  if (/\.[jt]sx$/.test(filename)) plugins.push('jsx');
  const ast = parse(source, {sourceFilename: filename, sourceType: 'unambiguous', tokens: true,
    allowReturnOutsideFunction: true, allowUndeclaredExports: true, plugins});
  return ast.tokens.filter(token => typeof token.type !== 'string' &&
    !['eof', 'template', '`'].includes(token.type.label)).map(token =>
    token.type.label === '${' ? ';' : source.slice(token.start, token.end));
}

export function unquote(value) {
  if (!/^['"`]/.test(value ?? '') || value[0] === '`' && value.includes('${')) return null;
  return value.slice(1, -1).replace(/\\(?:x([\da-fA-F]{2})|u(?:\{([\da-fA-F]+)\}|([\da-fA-F]{4}))|([\s\S]))/g,
    (_, x, codepoint, u, character) => x || codepoint || u ? String.fromCodePoint(parseInt(x ?? codepoint ?? u, 16)) : character === '\n' ? '' : ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v',0:'\0'}[character] ?? character));
}
