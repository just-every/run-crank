/** Binding projection for the frozen CandidateDeploymentSpec, not a provider plan. */
export const bindingPattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const classPattern = /^[$A-Z_a-z][$\w]*$/;
export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error(`Invalid ${label}: expected an object`);
  return value;
}
export function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`Unsupported ${label} field: ${key}`);
  return value;
}
export function array(value, label) {
  if (!Array.isArray(value)) throw Error(`Invalid ${label}: expected an array`);
  return value;
}
export function string(value, label, pattern) {
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) throw Error(`Invalid ${label}`);
  return value;
}
export function strings(value, label, pattern) {
  array(value, label).forEach(item => string(item, label, pattern));
  if (new Set(value).size !== value.length) throw Error(`Duplicate ${label}`);
  return [...value];
}
const list = (config, key) => config[key] === undefined ? [] : array(config[key], key);
const unsupported = ['services','vectorize','hyperdrive','dispatch_namespaces','mtls_certificates','workflows','pipelines','secrets_store_secrets','artifacts','ratelimits','ai','browser','images','ai_search','ai_search_namespaces','agent_memory','vpc_services','vpc_networks','worker_loaders','version_metadata','text_blobs','data_blobs','wasm_modules','containers','exports','cloudchamber','connect','unsafe_hello_world','flagship'];
// These fields configure builds, local development, or broker-owned deployment identity.
// Unknown top-level fields fail closed, including future native binding families.
const metadata = ['$schema','name','main','account_id','compatibility_date','compatibility_flags','workers_dev','preview_urls','route','routes','zone_id','usage_model','placement','limits','observability','tail_consumers','build','no_bundle','find_additional_modules','rules','base_dir','tsconfig','minify','define','alias','jsx_factory','jsx_fragment','keep_vars','send_metrics','dev','legacy_env','env','upload_source_maps','site','legacy_assets','configPath','userConfigPath','topLevelName','pages_build_output_dir','preserve_file_names','definedEnvironments','python_modules'];
function empty(value) {
  return value === undefined || (Array.isArray(value) ? value.length === 0 : value && typeof value === 'object' && Object.keys(value).length === 0);
}
export function validateWranglerShape(config) {
  keys(config, [...metadata,...unsupported,'vars','d1_databases','r2_buckets','kv_namespaces','analytics_engine_datasets','queues','durable_objects','migrations','triggers','send_email','assets','unsafe','logfwdr'], 'Wrangler');
  for (const key of unsupported) if (!empty(config[key])) throw Error(`Unsupported deployment binding: ${key}; an explicit consumer contract is required`);
  for (const key of ['tail_consumers','site','legacy_assets','env']) if (!empty(config[key])) throw Error(`Unsupported deployment configuration: ${key}`);
  for (const key of ['unsafe','logfwdr']) {
    if (config[key] === undefined) continue;
    keys(config[key], ['bindings'], key);
    if (list(config[key], 'bindings').length) throw Error(`Unsupported deployment binding: ${key}`);
  }
  if (config.assets !== undefined) {
    keys(config.assets, ['directory','binding','run_worker_first','html_handling','not_found_handling'], 'assets');
    if (config.assets.binding !== undefined && config.assets.binding !== 'ASSETS') throw Error('Unsupported assets binding: consumer requires ASSETS');
    if (config.assets.run_worker_first !== undefined && config.assets.run_worker_first !== true) throw Error('Unsupported assets run_worker_first: consumer runs Worker first');
    for (const key of ['html_handling','not_found_handling']) if (config.assets[key] !== undefined) throw Error(`Unsupported assets option: ${key}`);
  }
}
const emailPattern = /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/;
export function validateEmailSending(value) {
  const names = new Set();
  return array(value, 'emailSending').map(item => {
    keys(item, ['binding','destinationAddress','allowedDestinationAddresses','allowedSenderAddresses'], 'emailSending');
    string(item.binding, 'email binding', bindingPattern);
    if (names.has(item.binding)) throw Error(`Duplicate email binding: ${item.binding}`);
    names.add(item.binding);
    if (item.destinationAddress !== undefined && item.allowedDestinationAddresses !== undefined) throw Error(`Conflicting email recipient restrictions: ${item.binding}`);
    const result = {binding:item.binding};
    if (item.destinationAddress !== undefined) result.destinationAddress = string(item.destinationAddress, 'email destinationAddress', emailPattern);
    for (const key of ['allowedDestinationAddresses','allowedSenderAddresses']) if (item[key] !== undefined) {
      const addresses = strings(item[key], `email ${key}`, emailPattern);
      if (!addresses.length) throw Error(`Empty email ${key}`);
      result[key] = addresses;
    }
    return result;
  });
}
export function wranglerBindings(config) {
  validateWranglerShape(config);
  const resources = [];
  for (const [field,kind,allowed] of [
    ['d1_databases','d1',['binding','database_name','database_id','preview_database_id','migrations_dir','migrations_table','remote']],
    ['r2_buckets','r2',['binding','bucket_name','preview_bucket_name','jurisdiction','remote']],
    ['kv_namespaces','kv',['binding','id','preview_id','remote']],
    ['analytics_engine_datasets','analytics_engine',['binding','dataset']],
  ]) for (const item of list(config, field)) {
    keys(item, allowed, field);
    // A candidate requests installation-local resources. Geography cannot be erased.
    if (item.jurisdiction !== undefined) throw Error(`Unsupported ${field} jurisdiction`);
    resources.push({kind,binding:string(item.binding, `${field} binding`, bindingPattern)});
  }
  const queues = config.queues === undefined ? {} : keys(config.queues, ['producers','consumers'], 'queues');
  const producers = list(queues, 'producers');
  const queueNames = new Map();
  for (const item of producers) {
    keys(item, ['binding','queue'], 'queue producer');
    const binding = string(item.binding, 'queue binding', bindingPattern);
    string(item.queue, 'queue name');
    if (queueNames.has(item.queue)) throw Error(`Ambiguous queue name: ${item.queue}`);
    queueNames.set(item.queue, binding);
    resources.push({kind:'queue',binding});
  }
  // Preserve the established d1, r2, queue, kv, analytics ordering.
  resources.sort((a,b) => ['d1','r2','queue','kv','analytics_engine'].indexOf(a.kind) - ['d1','r2','queue','kv','analytics_engine'].indexOf(b.kind));
  const queueBinding = name => {
    if (!queueNames.has(name)) throw Error('Queue consumer must reference declared producer binding');
    return queueNames.get(name);
  };
  const queueConsumers = list(queues, 'consumers').map(item => {
    keys(item, ['queue','max_batch_size','max_batch_timeout','max_retries','dead_letter_queue'], 'queue consumer');
    return {binding:queueBinding(item.queue), maxBatchSize:item.max_batch_size === undefined ? 10 : item.max_batch_size, maxBatchTimeout:item.max_batch_timeout === undefined ? 5 : item.max_batch_timeout, maxRetries:item.max_retries === undefined ? 3 : item.max_retries, ...(item.dead_letter_queue === undefined ? {} : {deadLetterBinding:queueBinding(item.dead_letter_queue)})};
  });
  const durable = config.durable_objects === undefined ? {} : keys(config.durable_objects, ['bindings'], 'durable_objects');
  const durableObjects = list(durable, 'bindings').map(item => {
    keys(item, ['name','class_name','script_name','environment'], 'Durable Object binding');
    if (item.script_name !== undefined || item.environment !== undefined) throw Error('External Durable Object bindings require an explicit delivery contract');
    return {binding:string(item.name, 'Durable Object binding', bindingPattern),className:string(item.class_name, 'Durable Object class', classPattern)};
  });
  const durableObjectMigrations = list(config, 'migrations').map(item => {
    keys(item, ['tag','new_sqlite_classes','new_classes','deleted_classes','renamed_classes','transferred_classes'], 'Durable Object migration');
    const result = {tag:item.tag,newSqliteClasses:item.new_sqlite_classes === undefined ? [] : item.new_sqlite_classes};
    for (const [from,to] of [['new_classes','newClasses'],['deleted_classes','deletedClasses'],['renamed_classes','renamedClasses']]) if (item[from] !== undefined) result[to] = item[from];
    if (item.transferred_classes !== undefined) result.transferredClasses = array(item.transferred_classes, 'transferred_classes').map(transfer => {
      keys(transfer, ['from','from_script','to'], 'Durable Object transfer');
      return {from:transfer.from,fromScript:transfer.from_script,to:transfer.to};
    });
    return result;
  });
  const emailSending = validateEmailSending(list(config, 'send_email').map(item => {
    keys(item, ['name','destination_address','allowed_destination_addresses','allowed_sender_addresses'], 'send_email');
    return {binding:item.name,...(item.destination_address === undefined ? {} : {destinationAddress:item.destination_address}),...(item.allowed_destination_addresses === undefined ? {} : {allowedDestinationAddresses:item.allowed_destination_addresses}),...(item.allowed_sender_addresses === undefined ? {} : {allowedSenderAddresses:item.allowed_sender_addresses})};
  }));
  return {resources,durableObjects,durableObjectMigrations,queueConsumers,...(emailSending.length ? {emailSending} : {})};
}
export function validateDurableMigrations(value) {
  const tags = new Set();
  for (const item of array(value, 'durableObjectMigrations')) {
    keys(item, ['tag','newSqliteClasses','newClasses','deletedClasses','renamedClasses','transferredClasses'], 'Durable Object migration');
    string(item.tag, 'Durable Object migration tag', /^[\w.-]+$/);
    if (tags.has(item.tag)) throw Error('Duplicate Durable Object migration tag');
    tags.add(item.tag);
    for (const key of ['newSqliteClasses','newClasses','deletedClasses']) if (item[key] !== undefined) strings(item[key], key, classPattern);
    for (const key of ['renamedClasses','transferredClasses']) if (item[key] !== undefined) for (const row of array(item[key], key)) {
      keys(row, key === 'renamedClasses' ? ['from','to'] : ['from','to','fromScript'], key);
      string(row.from, `${key} from`, classPattern); string(row.to, `${key} to`, classPattern);
      if (key === 'transferredClasses') string(row.fromScript, 'transfer fromScript', /^[-a-z0-9]{1,63}$/);
    }
  }
}
