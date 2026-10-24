import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {array, object, keys, string, strings, bindingPattern, wranglerBindings, validateEmailSending, validateDurableMigrations} from './bindings.mjs';
import {sourcePath, decodeUtf8, collectMigrations} from './migrations.mjs';
import {validateDeclarations} from './declarations.mjs';
import {validateMailSpec} from './mail.mjs';
import {validateNativeExport} from './native-export.mjs';
import {seedSignIn} from './sign-in.mjs';
const reserved = new Set(['ASSETS','RER_RELEASE_DIGEST','RER_PREVIEW_TOKEN','RER_VERSION_METADATA','RER_INSTALLATION_ID','RER_MANAGEMENT_ORIGIN']);
const specKeys = ['schema','resources','migrations','compatibilityDate','compatibilityFlags','durableObjects','durableObjectMigrations','publicVariables','secretNames','optionalSecretNames','schedules','queueConsumers','healthPath','recovery','emailSending','providerEffects','surfaces','initialSetup','mail','nativeExport'];
/** Validate the exact producer contract without implying service acceptance or provider consent. */
export function validateCandidateSpec(spec) {
  keys(spec, specKeys, 'candidate specification');
  if (spec.schema !== 1) throw Error('Candidate deployment specification schema must be 1');
  validateDeclarations(spec);
  for (const field of ['resources','migrations','compatibilityFlags','durableObjects','durableObjectMigrations','secretNames','schedules','queueConsumers']) array(spec[field], field);
  if (spec.resources.length > 32 || spec.durableObjects.length > 32 || spec.migrations.length > 1000) throw Error('Candidate deployment specification exceeds supported limits');
  string(spec.compatibilityDate, 'compatibility date', /^\d{4}-\d{2}-\d{2}$/);
  const date = new Date(`${spec.compatibilityDate}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0,10) !== spec.compatibilityDate) throw Error('Invalid compatibility date');
  strings(spec.compatibilityFlags, 'compatibility flags', /^[a-zA-Z0-9_]+$/);
  string(spec.healthPath, 'health path', /^\/[a-zA-Z0-9/_-]*$/);
  string(spec.recovery, 'recovery instructions');
  const bindings = new Set();
  function claim(name, label, allowReserved = false) {
    string(name, label, bindingPattern);
    if (bindings.has(name) || (!allowReserved && reserved.has(name))) throw Error(`Conflicting or reserved binding: ${name}`);
    bindings.add(name);
  }
  for (const item of spec.resources) {
    keys(item, ['kind','binding','nameVariable'], 'resource');
    if (!['d1','r2','queue','kv','analytics_engine'].includes(item.kind)) throw Error('Invalid resource kind');
    claim(item.binding, 'resource binding');
  }
  for (const item of spec.durableObjects) {
    keys(item, ['binding','className'], 'Durable Object');
    claim(item.binding, 'Durable Object binding');
    string(item.className, 'Durable Object class', /^[$A-Z_a-z][$\w]*$/);
  }
  if (spec.emailSending !== undefined) {
    if (array(spec.emailSending, 'emailSending').length > 32) throw Error('Too many email bindings');
    for (const item of validateEmailSending(spec.emailSending)) claim(item.binding, 'email binding');
  }
  for (const item of spec.resources) if (item.nameVariable !== undefined) {
    if (typeof item.nameVariable !== 'string' || item.nameVariable.startsWith('RER_')) throw Error('Invalid resource name variable');
    claim(item.nameVariable, 'resource name variable');
  }
  for (const field of ['secretNames','optionalSecretNames']) if (spec[field] !== undefined) for (const name of strings(spec[field], field, bindingPattern)) claim(name, 'secret binding');
  object(spec.publicVariables, 'publicVariables');
  for (const [name,value] of Object.entries(spec.publicVariables)) {
    // These two broker values may occur as public build inputs in existing seeds.
    claim(name, 'public variable', ['RER_INSTALLATION_ID','RER_MANAGEMENT_ORIGIN'].includes(name));
    if (typeof value !== 'string') throw Error(`Public variable must be a string: ${name}`);
  }
  validateMailSpec(spec);
  validateDurableMigrations(spec.durableObjectMigrations);
  const migrations = new Set();
  for (const item of spec.migrations) {
    keys(item, ['binding','name','sha256','sql'], 'migration');
    string(item.name, 'migration name', /^[\w.-]+\.sql$/);
    if (!spec.resources.some(resource => resource.kind === 'd1' && resource.binding === item.binding)) throw Error('Migration requires a declared D1 binding');
    const identity = `${item.binding}/${item.name}`;
    if (migrations.has(identity)) throw Error(`Duplicate migration identity: ${identity}`);
    migrations.add(identity);
    if (typeof item.sql !== 'string' || Buffer.byteLength(item.sql) > 10 * 1024 * 1024 || item.name === 'setup-initial-owner.sql' || /\brer_migrations\b/i.test(item.sql)) throw Error('Candidate cannot replace owner initialization or migration authority');
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || createHash('sha256').update(item.sql).digest('hex') !== item.sha256) throw Error('Invalid migration byte digest');
  }
  if (spec.nativeExport !== undefined) validateNativeExport(spec.nativeExport, spec);
  strings(spec.schedules, 'schedules');
  for (const cron of spec.schedules) if (cron.length > 128 || cron.trim().split(/\s+/).length !== 5) throw Error('Invalid candidate schedule');
  const consumers = new Set();
  for (const item of spec.queueConsumers) {
    keys(item, ['binding','maxBatchSize','maxBatchTimeout','maxRetries','deadLetterBinding'], 'queue consumer');
    const exists = name => spec.resources.some(resource => resource.kind === 'queue' && resource.binding === name);
    if (!exists(item.binding) || consumers.has(item.binding)) throw Error('Invalid or duplicate queue consumer');
    consumers.add(item.binding);
    if (![item.maxBatchSize,item.maxBatchTimeout,item.maxRetries].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error('Invalid queue consumer limits');
    if (item.deadLetterBinding !== undefined && (item.deadLetterBinding === item.binding || !exists(item.deadLetterBinding))) throw Error('Invalid dead letter queue binding');
  }
  return spec;
}
// JSON.parse alone silently drops earlier duplicate keys, including restrictions.
function parseWranglerJson(text) {
  const value = JSON.parse(text);
  let position = 0;
  const whitespace = () => { while (/\s/.test(text[position] ?? '') && position < text.length) position++; };
  function token() {
    const start = position++;
    while (position < text.length) {
      if (text[position++] === '"') break;
      if (text[position - 1] === '\\') position++;
    }
    return JSON.parse(text.slice(start,position));
  }
  function visit() {
    whitespace();
    const opening = text[position];
    if (opening === '"') { token(); return; }
    if (opening !== '{' && opening !== '[') {
      while (position < text.length && !/[\s,}\]]/.test(text[position])) position++;
      return;
    }
    position++; whitespace();
    const closing = opening === '{' ? '}' : ']', names = new Set();
    if (text[position] === closing) { position++; return; }
    for (;;) {
      if (opening === '{') {
        whitespace(); const key = token();
        if (names.has(key)) throw Error(`Duplicate Wrangler JSON field: ${key}`);
        names.add(key); whitespace(); position++;
      }
      visit(); whitespace();
      if (text[position++] === closing) return;
    }
  }
  visit();
  return value;
}
/** Options are explicit packaging policy; callers may derive them from their own manifest adapter. */
export async function deploymentSpec(root, options = {}) {
  keys(options, ['publicVariableNames','secretNames','optionalSecretNames','extraMigrationDirectories','migrationPrefix','healthPath','recovery','wranglerFile','providerEffects','surfaces','initialSetup','mail','nativeExport'], 'deployment options');
  validateDeclarations(options);
  const {publicVariableNames = [], secretNames = [], optionalSecretNames = [], extraMigrationDirectories = [], migrationPrefix = '', healthPath = '/health', recovery, wranglerFile = 'dist/server/wrangler.json'} = options;
  strings(publicVariableNames, 'publicVariableNames', bindingPattern);
  strings(secretNames, 'secretNames', bindingPattern); strings(optionalSecretNames, 'optionalSecretNames', bindingPattern);
  array(extraMigrationDirectories, 'extraMigrationDirectories');
  if (typeof migrationPrefix !== 'string' || !/^[\w.-]*$/.test(migrationPrefix)) throw Error('Invalid migration prefix');
  const file = await sourcePath(root, wranglerFile);
  const config = parseWranglerJson(decodeUtf8(await readFile(file), 'Wrangler configuration'));
  const bindings = wranglerBindings(config);
  const directories = (config.d1_databases ?? []).map(item => {
    // Vite emits migrations_dir relative to the emitted configuration location.
    string(item.migrations_dir, 'D1 migrations_dir');
    return {binding:item.binding,path:resolve(dirname(file), item.migrations_dir),prefix:migrationPrefix};
  });
  const migrations = await collectMigrations(root, [...directories,...extraMigrationDirectories], bindings.resources);
  const publicVariables = {};
  object(config.vars === undefined ? {} : config.vars, 'Wrangler vars');
  for (const [name,value] of Object.entries(config.vars ?? {})) {
    if (!publicVariableNames.includes(name)) throw Error(`Undeclared public build variable: ${name}`);
    if (typeof value !== 'string') throw Error(`Public variable must be a string: ${name}`);
    Object.defineProperty(publicVariables, name, {value, enumerable:true, writable:true, configurable:true});
  }
  const triggers = config.triggers === undefined ? {} : keys(config.triggers, ['crons'], 'triggers');
  const spec = {schema:1,resources:bindings.resources,migrations,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags === undefined ? [] : config.compatibility_flags,durableObjects:bindings.durableObjects,durableObjectMigrations:bindings.durableObjectMigrations,publicVariables,secretNames:[...secretNames],optionalSecretNames:[...optionalSecretNames],schedules:triggers.crons === undefined ? [] : triggers.crons,queueConsumers:bindings.queueConsumers,healthPath,recovery,...(bindings.emailSending ? {emailSending:bindings.emailSending} : {})};
  for (const field of ['providerEffects','surfaces','initialSetup','mail','nativeExport']) if (options[field] !== undefined) spec[field] = structuredClone(options[field]);
  await seedSignIn(root, spec);
  return validateCandidateSpec(spec);
}
