// All recorded code uses the same source graph and seed ownership boundary.
import fs from 'node:fs';
import path from 'node:path';
import {raw, safe, requirePhysical, testSource, freedEntries, toolFile} from './files.mjs';
import {dependencies, resolve, external, bindings, lexicalExports} from './runtime-dependencies.mjs';
import {relocateDependencies} from './module-edges.mjs';
import {sharedNamespaces} from './copy-namespaces.mjs';
import {acknowledgementCommand} from './base-acknowledgements.mjs';
const code = name => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(name) && !testSource(name);
const inside = (name, prefix) => prefix === '.' ? !name.startsWith('../') && !path.posix.isAbsolute(name) : name === prefix || name.startsWith(prefix + '/');
const mapped = (source, copy) => copy.path + source.slice(copy.originPath.length);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function completeModuleCopies(root, plans, {tree, read, revision, base, baseArchive, recordPath, deliveries = [], ownerSources = new Map(), relocations = new Map()}) {
  const index = new Set(raw(root, 'ls-files', '-z').toString('utf8').split('\0').filter(Boolean));
  const required = new Set();
  const mappings = plans.filter(plan => !plan.retired).map(({copy}) => ({copy, ...namespace(copy)})).filter(mapping => mapping.from);
  const shared = sharedNamespaces(mappings);
  const cache = new Map(), planned = new Map(), recorded = new Map(), queue = [], withheld = [];
  const disk = {has: name => {
    try { return fs.lstatSync(path.join(root, name)).isFile(); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  }, read: name => local(name)};
  const blob = entry => read.blobs([entry.object]).get(entry.object).toString('utf8');
  const local = target => fs.readFileSync(path.join(root, target), 'utf8');
  tree.read = name => blob(tree.get(name));
  const refuse = (target, reason, recovery) => { throw Error(`Cannot refresh module ${target}: ${reason}. Run ${recovery}, then repeat refresh-base; no files were refreshed.`); };
  const removedObjects = freedEntries(root);
  for (const plan of plans) for (const target of plan.removed) {
    const stat = requirePhysical(root, target, {cache}).stat;
    if (stat) removedObjects.add(target, stat);
  }
  const inspect = target => requirePhysical(root, safe(target), {cache, freed: removedObjects.has});
  function enqueue(plan, source, entry, adapted = false) {
    const target = mapped(source, plan.copy);
    if (!adapted) planned.set(target, {plan, source, entry});
    if (code(source)) queue.push({plan, source, target, entry, adapted});
  }
  for (const plan of plans) {
    for (const target of Object.keys(plan.copy.files)) recorded.set(target, plan);
    for (const [source, entry] of plan.sources) enqueue(plan, source, entry);
    for (const target of Object.keys(plan.copy.adapted ?? {})) enqueue(plan, plan.copy.originPath + target.slice(plan.copy.path.length), null, true);
  }
  const directoryAdditions = new Set([...planned].filter(([target, {plan}]) => !Object.hasOwn(plan.copy.files, target) && !tree.has(plan.copy.originPath)).map(([target]) => target));
  function namespace(copy) {
    const file = Object.hasOwn(copy.files, copy.path) || tree.has(copy.originPath);
    if (file && path.posix.basename(copy.path) !== path.posix.basename(copy.originPath)) return {};
    return {directory: !file, to: file ? path.posix.dirname(copy.path) : copy.path,
      from: file ? path.posix.dirname(copy.originPath) : copy.originPath};
  }
  function witness(target, source) {
    if (plans.some(({copy}) => {
      const {to, from} = namespace(copy);
      return from && inside(target, to) && path.posix.join(from, path.posix.relative(to, target)) === source;
    })) return true;
    return recordedDestination(source).includes(target);
  }
  function recordedDestination(source) {
    // Prefer the explicitly selected subtree over a broader, sparse runtime
    // copy. Never choose between equally specific namespaces for the seed.
    let candidates = [...mappings, ...shared].filter(({from}) => inside(source, from));
    const specificity = Math.max(...candidates.map(({from}) => from.length));
    candidates = candidates.filter(({from}) => from.length === specificity);
    const destination = ({from, to}) => path.posix.join(to, path.posix.relative(from, source));
    const members = candidates.filter(mapping => mapping.copy && Object.hasOwn(mapping.copy.files, destination(mapping)));
    if (members.length) candidates = members;
    return [...new Set(candidates.map(destination))];
  }
  function include(source, target) {
    required.add(target);
    if (withheld.some(item => item.path === target)) refuse(target, 'a required module has an unplaceable dependency', '${EDITOR:-vi} base-copies.json');
    const physical = inspect(target), owner = recorded.get(target);
    if (owner?.removed.includes(target)) {
      const origin = owner.copy.originPath + target.slice(owner.copy.path.length);
      refuse(target, 'recorded dependency was removed but is still imported', index.has(target) ? `git restore -- ${quote(target)}` : `git -C ${quote(base)} show ${quote(owner.copy.revision + ':' + origin)} > ${quote(target)}`);
    }
    if (planned.has(target)) return;
    if (owner) return;
    if (index.has(target)) {
      if (!physical.stat) refuse(target, 'tracked edition source is missing', `git restore -- ${quote(target)}`);
      ownerSources.set(target, source);
      return; // Tracked, unrecorded source remains edition-owned, even at equal bytes.
    }
    if (physical.stat && !index.has(target)) refuse(target, 'existing file has no Base copy record or Git index entry', `git add -f -- ${quote(target)}`);
    let plan = plans.find(plan => inside(target, plan.copy.path));
    if (plan && mapped(source, plan.copy) !== target) refuse(target, 'conflicting directory mapping', '${EDITOR:-vi} base-copies.json');
    if (!plan) {
      if (plans.some(plan => inside(plan.copy.path, target))) refuse(target, 'overlapping copy mapping', '${EDITOR:-vi} base-copies.json');
      plan = {copy: {path: target, originPath: source, revision, files: {}, modes: {}}, sources: [], removed: []};
      plans.push(plan);
    }
    const entry = tree.get(source);
    plan.sources.push([source, entry]);
    enqueue(plan, source, entry);
  }
  for (const {source, origin, importers} of deliveries) {
    const targets = importers.map(importer => path.posix.join(path.posix.dirname(importer), path.posix.relative(path.posix.dirname(origin), source)));
    if (!tree.has(source)) refuse(source, 'migration delivery has no Base source', '${EDITOR:-vi} base-copies.json');
    for (const target of new Set(targets)) {
      if (!witness(target, source)) refuse(target, 'migration delivery has no witnessed destination', '${EDITOR:-vi} base-copies.json');
      include(source, target);
    }
  }
  // Template files can refer to another recorded copy whose Base origin is
  // elsewhere (for example foundation/template -> foundation/runtime). Existing
  // records and plans satisfy that local edge before looking for a new source.
  const view = {
    has: name => planned.has(name) || recorded.has(name) || index.has(name) && disk.has(name),
    read: name => planned.has(name) ? blob(planned.get(name).entry) : local(name),
  };
  function requests(bytes, source, target) {
    return dependencies(bytes, source).filter(request => {
      const origin = {}, localScope = {};
      resolve(tree, source, request.specifier, {...request, package: origin});
      resolve(disk, target, request.specifier, {...request, package: localScope});
      return request.specifier.startsWith('.') || origin.managed || localScope.managed;
    });
  }
  function edge(source, target, request) {
    const {specifier} = request;
    const originScope = {}, targetScope = {}, manifests = new Set();
    const dependency = resolve(tree, source, specifier, {...request, manifests, package: originScope});
    const destination = resolve(view, target, specifier, {...request, package: targetScope});
    if (!specifier.startsWith('.')) {
      if (originScope.external && targetScope.external && originScope.value === targetScope.value) return {...request, external: true};
      if (!targetScope.managed || originScope.external || targetScope.external) return {...request, reason: 'runtime package scope differs from its Base source'};
      if (destination && !dependency) return {...request, external: true};
      const expected = originScope.target && path.posix.join(path.posix.dirname(target), path.posix.relative(path.posix.dirname(source), originScope.target));
      if (expected !== targetScope.target || expected && ['.js', '.ts', '.jsx', '.tsx'].includes(path.posix.extname(expected)) && originScope.type !== targetScope.type) {
        return {...request, reason: 'runtime package target or format differs from its Base namespace'};
      }
    }
    if (destination && destination !== external) {
      const owner = recorded.get(destination);
      const source = planned.get(destination)?.source ?? (owner && owner.copy.originPath + destination.slice(owner.copy.path.length)) ?? dependency;
      return {...request, dependency: source, destination, satisfied: true};
    }
    const expected = dependency && path.posix.join(path.posix.dirname(target), path.posix.relative(path.posix.dirname(source), dependency));
    // Relocate only new deliveries. Existing files and acknowledged adaptations
    // retain their current imports and ownership, including old missing edges.
    if (specifier.startsWith('.') && dependency && !recorded.has(target) && !witness(expected, dependency)) {
      const destinations = recordedDestination(dependency);
      if (destinations.length > 1) return {...request, manifests, dependency, destination: expected,
        reason: `ambiguous Base copy mappings for ${dependency}: ${destinations.join(', ')}`};
      if (destinations.length === 1) {
        const destination = destinations[0];
        // Preserve extensionless TS and emitted-JS spellings by moving the
        // original request path by the same displacement as its resolved file.
        const requested = path.posix.join(path.posix.dirname(source), request.kind === 'require' ? specifier : decodeURIComponent(specifier));
        let relocation = path.posix.relative(path.posix.dirname(target), path.posix.join(path.posix.dirname(destination), path.posix.relative(path.posix.dirname(dependency), requested)));
        if (!relocation.startsWith('.')) relocation = './' + relocation;
        return {...request, manifests, dependency, destination, relocation};
      }
    }
    return {...request, manifests, dependency, destination: expected};
  }
  const key = (target, request) => JSON.stringify([target, request.kind, request.types, request.specifier]);
  const bootstrap = source => /^(?:edition-authoring|(?:default-seed|export)\/scripts\/base-cli\/edition-authoring)\//.test(source);
  // Snapshot the original unresolved set once, before closure can add a file.
  // Preserve these edges during traversal; required planned files may still
  // complete a sparse historical copy by satisfying them.
  const baseline = new Set();
  for (const {plan, source, target} of queue) {
    if (!Object.hasOwn(plan.copy.files, target) || !disk.has(target) || bootstrap(source)) continue;
    for (const request of requests(local(target), source, target)) {
      const candidate = edge(source, target, request);
      if (!resolve(disk, target, request.specifier, request) && !recorded.has(candidate.destination)) baseline.add(key(target, request));
    }
  }
  // Do not let an optional directory addition incidentally fill an old edge.
  for (const {plan, source, target} of queue) {
    if (!Object.hasOwn(plan.copy.files, target) || !disk.has(target)) continue;
    for (const request of requests(local(target), source, target)) if (baseline.has(key(target, request))) {
      const destination = resolve(view, target, request.specifier, request);
      if (!directoryAdditions.has(destination)) continue;
      const addition = planned.get(destination);
      addition.plan.sources = addition.plan.sources.filter(([name]) => name !== addition.source);
      planned.delete(destination);
      withheld.push({path: destination, originPath: addition.source, dependency: request.specifier});
    }
  }
  const incoming = new Set();
  for (const item of queue) for (const request of requests(item.adapted ? local(item.target) : blob(item.entry), item.source, item.target)) {
    if (baseline.has(key(item.target, request))) continue;
    const {destination} = edge(item.source, item.target, request);
    if (destination) incoming.add(destination);
  }
  function exportsAt(target, types = false, seen = new Set()) {
    if (seen.has(target)) return new Set();
    seen.add(target); inspect(target);
    if (!disk.has(target)) return null;
    if (!types && /\.d\.[cm]?ts$/.test(target)) return new Set();
    if (target.endsWith('.json')) return new Set(['default']);
    const result = lexicalExports(local(target), specifier => {
      const next = resolve(disk, target, specifier, {types});
      return next ? exportsAt(next, types, seen) : null;
    }, types);
    if (result === null) return null;
    const declaration = target.replace(/\.mjs$/, '.d.mts').replace(/\.js$/, '.d.ts');
    if (types && declaration !== target && disk.has(declaration)) {
      const declared = exportsAt(declaration, true, seen);
      if (declared === null) return null;
      for (const name of declared) result.add(name);
    }
    return result;
  }
  const seen = new Set();
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i], {plan, source, target, entry, adapted} = item;
    if (seen.has(target) || !adapted && !plan.sources.some(([name]) => name === source)) continue;
    seen.add(target);
    const bytes = adapted ? local(target) : blob(entry);
    const before = Object.hasOwn(plan.copy.files, target) && disk.has(target) ? local(target) : '';
    const imports = bindings(bytes), oldBindings = bindings(before);
    const typeImports = bindings(bytes, true), oldTypes = bindings(before, true);
    const edges = requests(bytes, source, target).map(request => edge(source, target, request));
    // lock.mjs reads the whole tool dynamically to identify it. Deliver that
    // same file set, including parser notices and modules outside its imports.
    if (/^(?:edition-authoring|(?:default-seed|export)\/scripts\/base-cli\/edition-authoring)\/lock\.mjs$/.test(source)) {
      const from = source.slice(0, -'lock.mjs'.length), to = target.slice(0, -'lock.mjs'.length);
      for (const dependency of tree.keys()) if (dependency.startsWith(from) && toolFile(dependency.slice(from.length))) {
        edges.push({dependency, destination: to + dependency.slice(from.length)});
      }
    }
    for (const {manifests = []} of [...edges]) for (const dependency of manifests) {
      edges.push({dependency, destination: path.posix.join(path.posix.dirname(target), path.posix.relative(path.posix.dirname(source), dependency))});
    }
    const declaration = source.replace(/\.mjs$/, '.d.mts').replace(/\.cjs$/, '.d.cts');
    if (declaration !== source && tree.has(declaration)) edges.push({dependency: declaration, destination: target.replace(/\.mjs$/, '.d.mts').replace(/\.cjs$/, '.d.cts')});
    const novel = directoryAdditions.has(target) && !required.has(target) && !incoming.has(target);
    const preserved = request => baseline.has(key(target, request));
    let hold;
    for (const edge of edges) {
      const {specifier, dependency, destination, satisfied} = edge;
      if (edge.external || preserved(edge)) continue;
      if (satisfied) continue;
      if (!dependency) refuse(target, edge.reason ?? `no Base source for ${specifier}`, `\${EDITOR:-vi} ${quote(target)}`);
      if (!witness(destination, dependency)) {
        if (novel) { hold = {path: target, originPath: source, dependency}; break; }
        refuse(target, edge.reason ?? `no copy mapping witnesses ${destination} from ${dependency}`, '${EDITOR:-vi} base-copies.json');
      }
    }
    if (hold) {
      plan.sources = plan.sources.filter(([name]) => name !== source);
      planned.delete(target); withheld.push(hold); continue;
    }
    for (const edge of edges) {
      const {specifier, dependency, destination} = edge;
      if (edge.external || preserved(edge)) continue;
      include(dependency, destination);
      const owner = recorded.get(destination);
      if (!adapted && !planned.has(destination) && (index.has(destination) || owner?.copy.adapted?.[destination])) {
        for (const [types, current, previous] of [[false, imports, oldBindings], [true, typeImports, oldTypes]]) {
          const exported = exportsAt(destination, types);
          for (const name of current.get(specifier) ?? []) if (exported && !exported.has(name) && !previous.get(specifier)?.has(name)) {
            const comparison = destination + '.base';
            const extract = baseArchive ? `cp ${quote(path.join(baseArchive, dependency))} ${quote(comparison)}` :
              `git -C ${quote(base)} show ${quote(revision + ':' + dependency)} > ${quote(comparison)}`;
            throw Error([
              `Cannot refresh module ${target}: ${destination} does not export ${name} required by Base ${dependency} at ${revision}. No files were refreshed.`,
              'Save the incoming dependency for comparison:', extract,
              `Merge the required exports from ${quote(comparison)} into ${quote(destination)}, preserving seed edits.`,
              ...(owner?.copy.adapted?.[destination] ? ['Review the reconciled bytes and mode, then acknowledge this adaptation:', acknowledgementCommand(root, destination, recordPath)] : []),
              `Remove ${quote(comparison)} after reconciliation, then repeat refresh-base.`,
            ].join('\n'));
          }
        }
      }
    }
    if (!adapted && edges.some(edge => edge.relocation)) relocations.set(target, Buffer.from(relocateDependencies(bytes, edges)));
  }
  return withheld;
}
