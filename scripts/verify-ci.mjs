import { appendFile, readFile, readdir } from 'node:fs/promises';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Reads only what a permission check needs from workflow YAML: nested block
// mappings and one-line values. A sequence or a value that continues on later
// lines is opaque; any other shape makes the file unreadable (null).
const opaque = Symbol('opaque');
function outline(text) {
 const root = {}, stack = [{ indent: -1, node: root }];
 let skip = Infinity, open;
 for (const raw of text.split(/\r?\n/)) {
  const line = raw.replace(/(^|\s)#.*$/, '').trimEnd(), indent = line.search(/\S/);
  if (indent < 0 || /^(---|\.\.\.)$/.test(line)) continue;
  const body = line.slice(indent), item = /^-(\s|$)/.test(body);
  if (indent > skip || (indent === skip && item)) continue;
  skip = Infinity;
  if (item) {
   if (!open || indent < open.indent) return null;
   open.parent[open.key] = opaque;
   skip = open.indent;
   open = undefined;
   continue;
  }
  const match = /^(?:'([^']*)'|"([^"]*)"|([^\s'"{[\]}&*!|>-][^:]*?))\s*:(?:\s+(.*))?$/.exec(body);
  if (!match) return null;
  while (stack.at(-1).indent >= indent) stack.pop();
  const parent = stack.at(-1).node, key = match[1] ?? match[2] ?? match[3], value = match[4]?.trim();
  if (!value) {
   parent[key] = {};
   stack.push({ indent, node: parent[key] });
   open = { indent, parent, key };
   continue;
  }
  open = undefined;
  skip = indent;
  const flow = /^\{(.*)\}$/.exec(value)?.[1].trim(), unquote = text => text.trim().replace(/^(['"])(.*)\1$/, '$2');
  parent[key] = flow !== undefined ? Object.fromEntries(flow ? flow.split(',').map(pair => pair.split(':').map(unquote)) : [])
   : /^[{[&*!|>]/.test(value) ? opaque : unquote(value);
 }
 return root;
}

// GitHub refuses to start a run whose called workflow requests more token
// permission than its calling job grants; actionlint does not report it.
const levels = ['none', 'read', 'write'];
const allScopes = ['actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'id-token',
 'issues', 'models', 'packages', 'pages', 'pull-requests', 'security-events', 'statuses'];
const readable = node => node && typeof node === 'object' && node['<<'] === undefined;
const level = (permissions, scope) => {
 if (permissions === 'read-all' || permissions === 'write-all') return permissions === 'read-all' ? 1 : 2;
 const index = readable(permissions) ? levels.indexOf(permissions[scope] ?? 'none') : -1;
 return index < 0 ? undefined : index;
};
async function workflowPermissionErrors(directory = '.github/workflows') {
 const files = (await readdir(directory)).filter(name => /\.ya?ml$/.test(name));
 const texts = Object.fromEntries(await Promise.all(files.map(async name => [name, await readFile(join(directory, name), 'utf8')])));
 const errors = [];
 for (const name of files.filter(file => texts[file].includes('./.github/workflows/'))) {
  const caller = outline(texts[name]);
  if (!readable(caller)) { errors.push(`${name}: cannot read its jobs`); continue; }
  for (const [id, job] of Object.entries(readable(caller.jobs) ? caller.jobs : {})) {
   const target = /^\.\/\.github\/workflows\/([^/@]+\.ya?ml)$/.exec(job?.uses ?? '')?.[1];
   if (!target) continue;
   const callee = texts[target] === undefined ? null : outline(texts[target]);
   if (!readable(callee) || !readable(job)) { errors.push(`${name} job ${id}: cannot read its call to ${target}`); continue; }
   const granted = job.permissions ?? caller.permissions;
   const requests = Object.entries(readable(callee.jobs) ? callee.jobs : {})
    .map(([calledId, called]) => [calledId, readable(called) ? called.permissions ?? callee.permissions : opaque])
    .filter(([, requested]) => requested !== undefined);
   if (requests.length && granted === undefined) { errors.push(`${name} job ${id}: grant permissions on the job that calls ${target}`); continue; }
   for (const [calledId, requested] of requests) {
    const scopes = requested === 'read-all' || requested === 'write-all' ? allScopes : readable(requested) ? Object.keys(requested) : null;
    const compared = scopes?.map(scope => [scope, level(requested, scope), level(granted, scope)]);
    if (!compared || compared.some(([, want, have]) => want === undefined || have === undefined)) {
     errors.push(`${name} job ${id}: cannot compare its permissions with ${target} job ${calledId}`);
    } else {
     for (const [scope, want, have] of compared) if (have < want) errors.push(`${name} job ${id} grants ${scope}: ${levels[have]}, but ${target} job ${calledId} requests ${scope}: ${levels[want]}`);
    }
   }
  }
 }
 return errors;
}

// Symlinked paths (macOS /tmp, linked checkouts) still run as the command.
const invokedDirectly = () => { try { return realpathSync(process.argv[1]) === realpathSync(import.meta.filename); } catch { return false; } };
if (invokedDirectly()) {
 const [mode, tier] = process.argv.slice(2);
 if (mode === '--plan' && !tier) {
  const { verificationPlan } = await import('./verify-app.mjs');
  const { planVerification } = await import('./verify-plan.mjs');
  const { lightNeedsBrowser } = await import('./verify-light.mjs');
  const plan = await verificationPlan();
  const decision = await planVerification({ plan });
  const output = Object.entries({ ...decision, matrix: JSON.stringify(decision.matrix), readers: JSON.stringify(decision.readers), has_shards: decision.matrix.include.length > 0, has_nightly: plan.nightly.length > 0, light_browser: lightNeedsBrowser(decision.readers, plan) })
   .map(([key, value]) => `${key}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
 } else if (mode === '--light' && !tier) {
  const { run } = await import('./verify-app.mjs');
  const readers = JSON.parse(process.env.LIGHT_READERS);
  if (!Array.isArray(readers) || readers.some(command => typeof command !== 'string')) throw Error('Invalid light readers');
  run('node node_modules/@runeditrun/rer/edition-authoring/cli.mjs check');
  run('pnpm run typecheck');
  run('pnpm exec rer check --profile first-party');
  run('pnpm exec rer build --site');
  for (const command of readers) run(command);
 } else if (mode === '--check-workflows' && !tier) {
  const errors = await workflowPermissionErrors();
  for (const error of errors) console.error(error);
  if (errors.length) process.exit(1);
  console.log('Every local reusable workflow call grants what its jobs request.');
 } else {
  const { verificationPlan, run } = await import('./verify-app.mjs');
  const plan = await verificationPlan();
  if (mode === '--matrix') {
   if (!['push', 'nightly', 'all'].includes(tier)) throw Error('Usage: verify-ci.mjs --matrix push|nightly|all');
   const shards = tier === 'all' ? [...plan.push, ...plan.nightly] : plan[tier];
   console.log(JSON.stringify({ include: shards.map(({ name, browser, hosted }) => ({ name, browser, hosted })) }));
  } else if (mode === '--build' && !tier) {
   for (const command of plan.build) run(command);
   if (process.env.GITHUB_ACTIONS === 'true') {
    if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '')) throw Error('Shared build requires a GitHub Actions commit');
    writeFileSync('dist/.ci-sha', process.env.GITHUB_SHA + '\n');
   }
  } else {
   const shard = [...plan.push, ...plan.nightly].find(shard => shard.name === mode);
   if (!shard || tier) throw Error('Usage: verify-ci.mjs SHARD');
   if (process.env.GITHUB_ACTIONS === 'true') {
    const sha = readFileSync('dist/.ci-sha', 'utf8').trim();
    if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') || sha !== process.env.GITHUB_SHA) throw Error('Build artifact belongs to another commit');
   }
   // Exactly one job retains rer verify's hosted-output and hydration checks.
   run(shard.hosted ? 'pnpm run verify' : 'pnpm run verify:app', { ...process.env, SEED_VERIFY_SHARD: shard.name });
  }
 }
}
