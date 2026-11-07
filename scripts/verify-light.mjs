import { access } from 'node:fs/promises';
import { join } from 'node:path';

const documents = new Set(['CONTRACT.md', 'ACCEPTANCE.md', 'CLAIMS.md', 'docs/CLAIMS.md', 'HANDOVER.md', 'STATUS.md']);
const allowed = path => documents.has(path) || path === 'sources.lock.json' || /^(?:evidence|\.artifacts)\/.+/.test(path);
const aliases = {
 'pnpm run test:site': ['tests/site.test.mjs'],
 'pnpm run test:runtime': ['tests/runtime.mjs'],
 'pnpm run test:email-link': ['tests/email-link.mjs'],
};

// These complete command forms were reviewed with Crank's assertions. Keep
// their flags and environment when running a reader; never evaluate shell to
// discover dependencies. Unknown commands select full verification.
function commandTests(command) {
 if (Object.hasOwn(aliases, command)) return aliases[command];
 const normalized = command
  .replace(/^(?:CRANK_PICKER_ONLY=1 )?CRANK_EVIDENCE="\$CRANK_EVIDENCE\/[a-z0-9-]+" /, '')
  .replace(/^sudo "\$\(command -v node\)" /, 'node ');
 const match = /^node(?: --test(?: --test-concurrency=[1-9]\d*)?(?: --test-(?:name|skip)-pattern='[^'\r\n]*')?)?((?: tests\/[A-Za-z0-9_./*-]+\.(?:mjs|ts|tsx))+)$/.exec(normalized);
 return match?.[1].trim().split(' ');
}

// Only existing readers with reviewed semantic dependencies can select light
// work. Source fixtures, HTTP assertions and browser journeys read no allowed
// document directly. The emitted run site reads CONTRACT.md.
export async function lightReaders(files, { cwd = process.cwd(), plan } = {}) {
 if (!files.length || !files.every(allowed)) return;
 const known = Object.fromEntries([
  ...['connections', 'request-limits', 'webhook-erasure', 'team', 'logic', 'crank',
   'ownership', 'skills', 'hold-cost', 'usage', 'app', 'batch', 'pagination',
   'historical', 'publish-authority', 'execution-queue', 'dispatch-authority',
   'version-comparison', 'deployment', 'grants', 'security', 'service-accounts',
   'executors', 'hosted-mail', 'drift', 'triggers', 'followups', 'ops', 'platform']
   .map(name => `tests/${name}.test.mjs`),
  ...['recurring', 'sibling', 'decision', 'executor-schema', 'digest', 'run-notices',
   'team', 'sample', 'app-poll', 'inbound-email', 'financial', 'invoice-outcome',
   'custom', 'custom-search', 'ai-steps', 'editor', 'gmail-search', 'drift',
   'mcp-client', 'migration', 'authoring'].map(name => `tests/${name}-browser.mjs`),
  'tests/executor-linux.mjs', 'tests/runtime.mjs', 'tests/email-link.mjs',
 ].map(path => [path, []]));
 known['tests/site.test.mjs'] = ['CONTRACT.md'];
 const relative = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/')
  && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..');
 if (plan.readers !== undefined) {
  if (!plan.readers || typeof plan.readers !== 'object' || Array.isArray(plan.readers)) return;
  for (const [path, dependencies] of Object.entries(plan.readers)) {
   if (!relative(path) || !/^tests\/[A-Za-z0-9_./*-]+\.(?:mjs|ts|tsx)$/.test(path)
    || !Array.isArray(dependencies) || !dependencies.every(relative)) return;
   known[path] = dependencies;
  }
 }
 // Edition-owned lock validation remains mandatory, even for evidence-only work.
 for (const path of ['edition.json', 'sources.lock.json', 'scripts/edition-authoring/cli.mjs']) await access(join(cwd, path));
 if (files.some(path => /^(?:evidence|\.artifacts)\//.test(path) && !/\.(?:md|txt|png|jpe?g|pdf)$/.test(path))) return;
 const commands = new Set(), changed = new Set(files);
 for (const shard of [...plan.push, ...plan.nightly]) for (const command of shard.commands) {
  const paths = commandTests(command);
  if (!paths) return;
  for (const path of paths) {
   if (!Object.hasOwn(known, path)) return;
   if (!path.includes('*')) await access(join(cwd, path));
  }
  if (paths.some(path => known[path].some(dependency => changed.has(dependency)))) {
   // Those readers need the shared Worker or Linux preparation, so retain full
   // coverage if an edition gives them a new document dependency.
   if (paths.some(path => ['tests/runtime.mjs', 'tests/email-link.mjs', 'tests/executor-linux.mjs'].includes(path))) return;
   commands.add(command);
  }
 }
 if (files.some(path => documents.has(path))) {
  await access(join(cwd, 'src/base/contract-docs.mjs'));
  commands.add('node src/base/contract-docs.mjs check');
 }
 return [...commands];
}

export function lightNeedsBrowser(readers, plan) {
 return [...plan.push, ...plan.nightly].some(shard => shard.browser && shard.commands.some(command => readers.includes(command)));
}
