// Template adoption is a separate, narrow ownership decision: only tracked
// copies of known template bytes qualify. Helpers use the ordinary refresh
// preflight and share the workflow's all-or-nothing write plan.
import fs from 'node:fs';
import path from 'node:path';
import {raw, safe, physicalEntry, requirePhysical} from './files.mjs';
import {workflowScripts, literalPaths} from './workflow-scripts.mjs';

const inside = (name, prefix) => name === prefix || name.startsWith(prefix + '/');
const mapped = (source, copy) => copy.path + source.slice(copy.originPath.length);
const templates = [
  ['.github/workflows/verify.yml', ['export/verify.yml', 'default-seed/.github/workflows/verify.yml']],
  ['.github/workflows/verify-nightly.yml', ['export/verify-nightly.yml', 'default-seed/.github/workflows/verify-nightly.yml']],
  ['VERIFY-WORKFLOW.md', ['export/VERIFY-WORKFLOW.md', 'default-seed/VERIFY-WORKFLOW.md']],
];
const tracked = root => new Set(raw(root, 'ls-files', '-z').toString('utf8').split('\0').filter(Boolean));

function include(plans, target, source, entry, revision) {
  let plan = plans.find(plan => inside(target, plan.copy.path));
  if (plan && mapped(source, plan.copy) !== target) throw Error(`Workflow dependency ${target} conflicts with its Base copy mapping`);
  if (plan?.removed.includes(target)) throw Error(`Workflow dependency ${target} was removed locally but is still invoked; restore it before refresh-base; no files were refreshed.`);
  if (!plan) {
    if (plans.some(plan => inside(plan.copy.path, target))) throw Error(`Workflow dependency ${target} overlaps an existing Base copy`);
    plan = {copy: {path: target, originPath: source, revision, files: {}, modes: {}}, sources: [], removed: []};
    plans.push(plan);
  }
  if (!plan.sources.some(([name]) => name === source)) plan.sources.push([source, entry]);
}

export function adoptWorkflowTemplates(root, plans, {tree, read, revision, files}) {
  const index = tracked(root), templateAdoptions = [], notices = [];
  for (const [target, historySources] of templates) {
    const [source] = historySources;
    if (!tree.has(source)) continue;
    const owner = plans.find(plan => inside(target, plan.copy.path));
    if (owner && !owner.copy.adapted?.[target]) continue;
    const physical = physicalEntry(root, target);
    if (physical.kind === 'alias') {
      notices.push(`${target}: preserved physical entry ${physical.physical}; indexed spelling differs. Move it aside and restore ${target} before adopting the template.`);
      continue;
    }
    requirePhysical(root, target);
    const file = files.get(target) ?? (physical.stat && {regular: true, read: () => fs.readFileSync(physical.target)});
    if (!file?.regular) continue;
    let match;
    if (!owner && index.has(target)) {
      const bytes = file.read();
      // Full committed history includes the published 0.2.83 runner.temp
      // template as well as earlier default-seed mirrors. No release pins or
      // guessed structural equality can transfer a seed's ownership.
      match = historySources.flatMap(name => read.history(revision, name))
        .find(entry => read.blobs([entry.object]).get(entry.object).equals(bytes));
    }
    if (match) {
      include(plans, target, source, tree.get(source), revision);
      templateAdoptions.push({path: target, originPath: source, from: match.revision});
    } else if (target.endsWith('.yml') && !file.read().equals(read.blobs([tree.get(source).object]).get(tree.get(source).object))) {
      notices.push(`${target}: preserved seed-owned workflow. The current template pins Ubuntu 24.04 and moves browser and apt caches to the runner temporary directory. To adopt, merge export/${path.posix.basename(source)} from Base ${revision} into ${target}, then run node node_modules/@runeditrun/rer/edition-authoring/cli.mjs record-base ${target} ${source} ${revision} --base <base-checkout> and repeat rer refresh-base --ref ${revision} --base <base-checkout>.`);
    }
  }
  return {templateAdoptions, notices};
}

function invocations(text) {
  const {scripts, uses} = workflowScripts(text);
  const paths = scripts.flatMap(script => literalPaths(script, {helpersOnly: true})).flatMap(name => {
    try { return [safe(name)]; }
    catch (error) {
      if (name.startsWith('scripts/') || name.startsWith('.github/workflows/')) throw error;
      return []; // A URL or command option is not a relative helper path.
    }
  });
  // A workflow's archive/cache/build inputs do not select application source.
  // Tooling namespaces and explicitly selected ./ helpers retain acquisition.
  return [...new Set([...uses.map(name => safe(name.slice(2))), ...paths])];
}

function candidates(invoked) {
  if (invoked.startsWith('.github/workflows/')) return ['export/' + path.posix.basename(invoked), 'default-seed/' + invoked];
  return ['export/' + invoked.replace(/^scripts\//, ''), 'default-seed/' + invoked,
    ...(invoked.startsWith('scripts/') ? [invoked.slice(8)] : [])]
    .filter(name => !name.startsWith('scripts/') && !name.startsWith('.github/workflows/'));
}

export function completeWorkflowHelpers(root, plans, {tree, read, revision}) {
  const index = tracked(root);
  const queue = plans.flatMap(plan => plan.sources.filter(([source]) => /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(mapped(source, plan.copy)))
    .map(([source, entry]) => ({source, entry, target: mapped(source, plan.copy)})));
  // Preserved and adapted workflows have the same helper requirements as a
  // copied workflow. Parse the bytes that will actually remain in the seed.
  const queued = new Set(queue.map(item => item.target));
  for (const target of index) if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(target) && !queued.has(target)) {
    // Template adoption already preserves an unrecorded physical alias with a
    // notice. It cannot become a canonical caller in the helper write plan.
    if (templates.some(([name]) => name === target) && physicalEntry(root, target).kind === 'alias') continue;
    const {stat} = requirePhysical(root, target);
    if (stat) queue.push({target});
  }
  const seen = new Set();
  for (let i = 0; i < queue.length; i++) {
    const {entry, target} = queue[i];
    if (seen.has(target)) continue;
    seen.add(target);
    const destinationRoot = target.includes('.github/workflows/') ? target.slice(0, target.indexOf('.github/workflows/')) : '';
    const text = entry ? read.blobs([entry.object]).get(entry.object).toString('utf8') : fs.readFileSync(path.join(root, target), 'utf8');
    for (const invoked of invocations(text)) {
      const dependency = candidates(invoked).find(name => tree.has(name));
      if (!dependency) continue;
      const destination = safe(destinationRoot + invoked);
      const {stat} = requirePhysical(root, destination);
      const owner = plans.find(plan => inside(destination, plan.copy.path));
      if (owner?.removed.includes(destination)) throw Error(`Workflow dependency ${destination} was removed locally but is still invoked; restore it before refresh-base; no files were refreshed.`);
      const planned = owner?.sources.find(([name]) => mapped(name, owner.copy) === destination);
      if (planned) {
        if (/\.ya?ml$/.test(planned[0])) queue.push({source: planned[0], entry: planned[1], target: destination});
        continue;
      }
      // Tracked, unrecorded helpers and acknowledged adaptations belong to the
      // seed. Equality never transfers that ownership, or untracked ownership.
      if (stat && (index.has(destination) || owner?.copy.adapted?.[destination])) continue;
      if (!stat && index.has(destination)) throw Error(`Workflow dependency ${destination} is tracked but missing; restore it before refresh-base; no files were refreshed.`);
      if (stat) throw Error(`Cannot refresh workflow dependency ${destination}: existing file has no Base copy record or Git index entry. Move it aside or explicitly record-base it before refresh-base; no files were refreshed.`);
      include(plans, destination, dependency, tree.get(dependency), revision);
      if (/\.ya?ml$/.test(dependency)) queue.push({source: dependency, entry: tree.get(dependency), target: destination});
    }
  }
}
