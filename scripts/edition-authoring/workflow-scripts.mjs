import {parseDocument, isMap, isSeq, isScalar} from './vendor/yaml/index.mjs';

// YAML owns scalar decoding, folding, indentation, aliases and flow syntax.
// Only actual workflow job/step nodes contribute commands or local uses.
export function workflowScripts(text) {
  const document = parseDocument(text, {uniqueKeys: true});
  if (document.errors.length) throw Error(`Cannot parse workflow: ${document.errors.map(error => error.message).join('; ')}`);
  const dereference = node => node?.resolve ? node.resolve(document) : node;
  const scalar = node => {
    const value = dereference(node);
    return isScalar(value) && typeof value.value === 'string' ? value.value : null;
  };
  const result = {scripts: [], uses: []};
  const jobs = dereference(document.get('jobs', true));
  if (!isMap(jobs)) return result;
  for (const {value} of jobs.items) {
    const job = dereference(value);
    if (!isMap(job)) continue;
    const reusable = scalar(job.get('uses', true));
    if (reusable?.startsWith('./')) result.uses.push(reusable);
    const steps = dereference(job.get('steps', true));
    if (!isSeq(steps)) continue;
    for (let step of steps.items) {
      if (step?.resolve) step = step.resolve(document);
      if (!isMap(step)) continue;
      const run = scalar(step.get('run', true)), uses = scalar(step.get('uses', true));
      if (run !== null) result.scripts.push(run);
      if (uses?.startsWith('./')) result.uses.push(uses);
    }
  }
  return result;
}

// Shell lexical words, including adjacent quoted fragments and escaped spaces.
// Expansions make a word dynamic; their literal subcommands are scanned too.
// Quoted command strings are scanned recursively, so wrappers need no name list.
export function shellWords(script) {
  const words = [];
  let value = '', dynamic = false, quote = null, active = false;
  const finish = () => {
    if (active) words.push({value, dynamic});
    value = ''; dynamic = false; active = false;
  };
  for (let i = 0; i < script.length; i++) {
    const character = script[i];
    if (character === '\\' && quote !== "'") {
      const next = script[++i];
      if (next === '\n') continue;
      if (next === undefined) throw Error('Incomplete shell escape in workflow');
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) value += '\\';
      value += next; active = true; continue;
    }
    if (quote !== "'" && character === '$' && script[i + 1] === '(') {
      let depth = 1, end = i + 2, innerQuote = null;
      for (; end < script.length; end++) {
        const c = script[end];
        if (c === '\\' && innerQuote !== "'") { end++; continue; }
        if (innerQuote) { if (c === innerQuote) innerQuote = null; continue; }
        if (c === '"' || c === "'") { innerQuote = c; continue; }
        if (c === '(') depth++;
        if (c === ')') { depth--; if (!depth) break; }
      }
      if (depth) throw Error('Unclosed command substitution in workflow');
      words.push(...shellWords(script.slice(i + 2, end)));
      value += '$()'; dynamic = true; active = true; i = end; continue;
    }
    if (quote !== "'" && character === '`') {
      let end = i + 1;
      for (; end < script.length; end++) {
        if (script[end] === '\\') { end++; continue; }
        if (script[end] === '`') break;
      }
      if (end === script.length) throw Error('Unclosed command substitution in workflow');
      words.push(...shellWords(script.slice(i + 1, end)));
      value += '``'; dynamic = true; active = true; i = end; continue;
    }
    if (quote) {
      if (character === quote) { quote = null; continue; }
      if (quote === '"' && ['$','`'].includes(character)) dynamic = true;
      value += character; active = true; continue;
    }
    if (character === '"' || character === "'") { quote = character; active = true; continue; }
    if (character === '#' && !active) {
      while (i + 1 < script.length && script[i + 1] !== '\n') i++;
      continue;
    }
    if (/\s|[;|&()<>]/.test(character)) { finish(); continue; }
    if (['$', '`', '*', '?', '['].includes(character)) dynamic = true;
    value += character; active = true;
  }
  if (quote) throw Error('Unclosed shell quote in workflow');
  finish();
  return words;
}

export function literalPaths(script) {
  const names = new Set();
  function scan(text, ancestors = new Set(), words = shellWords(text)) {
    if (ancestors.has(text)) return;
    const nested = new Set([...ancestors, text]);
    for (const {value, dynamic} of words) {
      if (dynamic) continue;
      const relative = value.replace(/^\.\//, '');
      if ((value.startsWith('./') || relative.startsWith('scripts/') || !/\s/.test(value) && (relative.includes('/') || /\.[a-z0-9]+$/i.test(relative))) && !relative.startsWith('/')) names.add(relative);
      // A complete quoted path is one word; only script-like quoted content is
      // recursively tokenized, never a path whose filename contains whitespace.
      else if (/\s/.test(value)) {
        // Decoded arguments may be prose, not another shell program. A quote
        // that was literal in its enclosing word must not invalidate that
        // workflow. Recurse only when the whole argument is valid shell text;
        // the actual run script and its substitutions are still strict.
        let words;
        try { words = shellWords(value); }
        catch { continue; }
        scan(value, nested, words);
      }
    }
  }
  scan(script);
  return [...names];
}
