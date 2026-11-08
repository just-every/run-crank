import {canonical} from './module-resolution.mjs';
import {parse} from './vendor/babel-parser/babel-parser/index.mjs';

const literal = node => node?.type === 'StringLiteral' ? node.value :
  node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : undefined;
const unwrap = node => ['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSInstantiationExpression', 'ParenthesizedExpression'].includes(node?.type) ? unwrap(node.expression) : node;
const property = node => node?.computed ? literal(node.property) : node?.property?.name;
const member = node => ['MemberExpression', 'OptionalMemberExpression'].includes(node?.type);
const call = node => ['CallExpression', 'OptionalCallExpression', 'NewExpression'].includes(node?.type);
function* nodes(root) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node.type !== 'string') continue;
    yield node;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object' && typeof value.type === 'string') pending.push(value);
    }
  }
}

const parsed = new Map();

// Authoring follows module imports. History isolation also follows URL resources
// that bundlers can publish without importing them into the authoring tool.
export function dependencies(source, filename = 'module.mjs', {resources = false} = {}) {
  const result = edges(source, filename);
  return resources ? result : result.filter(request => request.kind !== 'resource');
}

// Parsing, including erased TS edges and calls nested in templates/JSX, precedes
// resolution. Every resulting edge uses the same virtual Node resolver.
function edges(source, filename) {
  let versions = parsed.get(filename);
  if (versions?.has(source)) return versions.get(source);
  const plugins = ['decorators-legacy', 'deprecatedImportAssert'];
  if (/\.[cm]?tsx?$/.test(filename)) plugins.push(['typescript', {dts: /\.d\.[cm]?ts$/.test(filename)}]);
  if (/\.[jt]sx$/.test(filename)) plugins.push('jsx');
  const ast = parse(source, {sourceFilename: filename, sourceType: 'unambiguous', plugins,
    createImportExpressions: true, allowReturnOutsideFunction: true, allowUndeclaredExports: true});
  const all = [...nodes(ast)], result = [], loaders = new Set(['require']), factories = new Set(), moduleNamespaces = new Set();
  const identifier = (node, names) => node?.type === 'Identifier' && names.has(node.name);
  const moduleRequest = node => call(node) && identifier(unwrap(node.callee), loaders) && ['module', 'node:module'].includes(literal(node.arguments[0]));
  for (const node of all) if (node.type === 'ImportDeclaration' && ['module', 'node:module'].includes(node.source.value)) {
    for (const item of node.specifiers) {
      if (item.type === 'ImportSpecifier' && (item.imported.name ?? item.imported.value) === 'createRequire') factories.add(item.local.name);
      if (['ImportNamespaceSpecifier', 'ImportDefaultSpecifier'].includes(item.type)) moduleNamespaces.add(item.local.name);
    }
  }
  const requireFunction = node => {
    node = unwrap(node);
    return identifier(node, loaders) || call(node) && (factory(node.callee) || member(node.callee) && property(node.callee) === 'bind' && requireFunction(node.callee.object)) || member(node) && property(node) === 'require' && node.object?.type === 'Identifier' && node.object.name === 'module';
  };
  const factory = node => {
    node = unwrap(node);
    return identifier(node, factories) || call(node) && member(node.callee) && property(node.callee) === 'bind' && factory(node.callee.object) || member(node) && property(node) === 'createRequire' && (identifier(node.object, moduleNamespaces) || moduleRequest(node.object));
  };
  // Static aliases reach a fixed point, independently of declaration order.
  let changed;
  do {
    changed = false;
    const add = (names, name) => { if (!names.has(name)) { names.add(name); changed = true; } };
    for (const node of all) if (node.type === 'VariableDeclarator') {
      const init = unwrap(node.init);
      if (node.id.type === 'Identifier') {
        if (requireFunction(init) || call(init) && factory(init.callee)) add(loaders, node.id.name);
        if (factory(init)) add(factories, node.id.name);
        if (moduleRequest(init)) add(moduleNamespaces, node.id.name);
      } else if (node.id.type === 'ObjectPattern' && moduleRequest(init)) {
        for (const item of node.id.properties) if (item.type === 'ObjectProperty' && (item.key.name ?? literal(item.key)) === 'createRequire' && item.value.type === 'Identifier') add(factories, item.value.name);
      }
    }
  } while (changed);
  const add = (node, kind, types = false) => {
    node = unwrap(node);
    const specifier = literal(node);
    if (specifier) result.push({specifier: canonical(specifier, kind), kind, types, start: node.start, end: node.end, literal: specifier});
  };
  for (const node of all) {
    if (node.type === 'ImportDeclaration') {
      const erased = node.importKind === 'type' || node.specifiers.length > 0 && node.specifiers.every(item => item.importKind === 'type');
      add(node.source, 'import', erased);
    } else if (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      const erased = node.exportKind === 'type' || node.specifiers?.length > 0 && node.specifiers.every(item => item.exportKind === 'type');
      add(node.source, 'import', erased);
    } else if (node.type === 'TSImportType') add(node.argument, 'import', true);
    else if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference') add(node.moduleReference.expression, 'require', node.importKind === 'type');
    else if (node.type === 'ImportExpression') add(node.source, 'import');
    else if (call(node)) {
      let callee = unwrap(node.callee), argument = node.arguments[0];
      // Vite emits literal import.meta.url resources, including the URL nested
      // in Worker/SharedWorker constructors, without an import declaration.
      const base = unwrap(node.arguments[1]), meta = unwrap(base?.object);
      if (node.type === 'NewExpression' && callee?.type === 'Identifier' && callee.name === 'URL'
        && member(base) && property(base) === 'url' && meta?.type === 'MetaProperty'
        && meta.meta.name === 'import' && meta.property.name === 'meta') add(argument, 'resource');
      if (member(callee) && property(callee) === 'bind' && requireFunction(callee.object)) { add(node.arguments[1], 'require'); continue; }
      if (member(callee) && callee.object?.type === 'Identifier' && callee.object.name === 'Reflect' && ['apply', 'construct'].includes(property(callee)) && requireFunction(node.arguments[0])) {
        add(node.arguments[property(callee) === 'apply' ? 2 : 1]?.elements?.[0], 'require'); continue;
      }
      if (callee?.type === 'Import') { add(argument, 'import'); continue; }
      if (member(callee) && ['call', 'apply'].includes(property(callee))) {
        argument = property(callee) === 'apply' ? node.arguments[1]?.elements?.[0] : node.arguments[1];
        callee = unwrap(callee.object);
      }
      if (member(callee) && property(callee) === 'resolve') callee = unwrap(callee.object);
      if (requireFunction(callee)) add(argument, 'require');
    }
  }
  if (!versions) parsed.set(filename, versions = new Map());
  versions.set(source, result);
  return result;
}

// Only parsed dependency literals are rewritten: comments, strings and JSX
// text that happen to contain the same path remain edition source.
export function relocateDependencies(source, requests) {
  const replacements = new Map(requests.filter(request => request.relocation).map(request => [request.start, request]));
  for (const {start, end, literal, specifier, relocation} of [...replacements.values()].sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + JSON.stringify(relocation + literal.slice(specifier.length)) + source.slice(end);
  }
  return source;
}
