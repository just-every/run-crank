import {tokens, unquote} from './module-syntax.mjs';
import {canonical} from './module-resolution.mjs';
export {resolve, external} from './module-resolution.mjs';

export {dependencies} from './module-edges.mjs';

// Binding checks are lexical: unknown export forms remain unknown, never absent.
export function bindings(source, types = false) {
  const t = tokens(source), result = new Map();
  for (let i = 0; i < t.length; i++) {
    if (!['import', 'export'].includes(t[i]) || ['.', '('].includes(t[i + 1])) continue;
    let end = i + 1;
    while (end < t.length && ![';', 'import', 'export'].includes(t[end]) && t[end] !== 'from') end++;
    if (t[end] !== 'from') continue;
    const specifier = canonical(unquote(t[end + 1]));
    if (!specifier) continue;
    const names = new Set(result.get(specifier) ?? []);
    let start = i + 1;
    const declarationType = t[start] === 'type' && start + 1 < end && t[start + 1] !== ',';
    if (declarationType) start++;
    if (declarationType === types && t[i] === 'import' && /^[\w$]+$/.test(t[start] ?? '') && t[start] !== 'from') names.add('default');
    const open = t.indexOf('{', start);
    if (open >= 0 && open < end) for (let j = open + 1; j < end && t[j] !== '}'; j++) {
      if (t[j] === ',') continue;
      const inlineType = t[j] === 'type' && /^[\w$]+$/.test(t[j + 1] ?? '') && t[j + 1] !== 'as';
      if (inlineType) j++;
      if ((declarationType || inlineType) === types) names.add(unquote(t[j]) ?? t[j]);
      if (t[j + 1] === 'as') j += 2;
    }
    result.set(specifier, names);
  }
  return result;
}
export function lexicalExports(source, star, types = false) {
  const t = tokens(source), names = new Set();
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== 'export') continue;
    let j = i + 1;
    if (t[j] === 'default') { if (types || !['interface', 'type'].includes(t[j + 1])) names.add('default'); continue; }
    const declared = t[j] === 'declare';
    if (declared) j++;
    if (t[j] === 'async') j++;
    if (['const', 'let', 'var'].includes(t[j]) && ['{', '['].includes(t[j + 1])) return null;
    if (['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'namespace'].includes(t[j]) && t[j + 1] !== '{') {
      if (!types && (declared || ['interface', 'type'].includes(t[j]))) continue;
      const name = t[j] === 'function' && t[j + 1] === '*' ? t[j + 2] : t[j + 1];
      if (!/^[\w$]+$/.test(name ?? '')) return null;
      names.add(name);
      if (['const', 'let', 'var'].includes(t[j])) {
        let depth = 0;
        for (let k = j + 2; k < t.length; k++) {
          if (!depth && [';', 'export', 'import'].includes(t[k])) break;
          if (['(', '[', '{'].includes(t[k])) depth++;
          if ([')', ']', '}'].includes(t[k])) depth--;
          if (!depth && t[k] === ',') {
            if (!/^[\w$]+$/.test(t[k + 1] ?? '') || !['=', ':'].includes(t[k + 2])) return null;
            names.add(t[k + 1]);
          }
        }
      }
      continue;
    }
    const declarationType = t[j] === 'type';
    if (declarationType) {
      if (!types) continue;
      j++;
    }
    if (t[j] === '*') {
      if (t[j + 1] === 'as') { names.add(t[j + 2]); continue; }
      const specifier = unquote(t[j + 2]);
      if (!specifier?.startsWith('.')) return null;
      const inherited = star(specifier);
      if (inherited === null) return null;
      for (const name of inherited) if (name !== 'default') names.add(name);
    }
    if (t[j] === '{') for (j++; j < t.length && t[j] !== '}'; j++) {
      if (t[j] === ',') continue;
      const inlineType = t[j] === 'type' && /^[\w$]+$/.test(t[j + 1] ?? '') && t[j + 1] !== 'as';
      if (inlineType) { j++; if (!types) { if (t[j + 1] === 'as') j += 2; continue; } }
      if (t[j + 1] === 'as') { names.add(unquote(t[j + 2]) ?? t[j + 2]); j += 2; }
      else names.add(unquote(t[j]) ?? t[j]);
    }
  }
  return names;
}
