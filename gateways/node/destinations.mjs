import { dirname, posix, resolve } from 'node:path';
import { normalizedHost } from './network-policy.mjs';
import { fail, isObject } from './errors.mjs';

const refused = () => fail('operation_refused', 'Operation destination is outside the exact current private destination grant.');
const only = (object, keys) => isObject(object) && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
export function deriveDestination(op, manifestPath) {
  const c = op.connection;
  if (['postgres-query', 'mysql-query', 'sqlserver-query'].includes(op.type)) {
    return { type: 'database', host: normalizedHost(c[op.type === 'sqlserver-query' ? 'server' : 'host']), port: c.port, database: c.database };
  }
  if (op.type === 'sftp-lines') return { type: 'sftp', host: normalizedHost(c.host), port: c.port, path_prefix: posix.normalize(op.path) };
  if (op.type === 's3-lines') return { type: 's3', endpoint: new URL(c.endpoint).origin, bucket: op.bucket, prefix: op.key };
  if (['sqlite-query', 'file-lines'].includes(op.type)) return { type: 'local', path: resolve(dirname(resolve(manifestPath)), op.type === 'sqlite-query' ? op.database : op.path) };
  refused();
}
export function checkDestination(op, manifestPath, spec) {
  const actual = deriveDestination(op, manifestPath);
  if (!isObject(spec) || actual.type !== spec.type) refused();
  if (actual.type === 'database') {
    if (!only(spec, ['type', 'host', 'port', 'database']) || normalizedHost(spec.host) !== actual.host || spec.port !== actual.port || spec.database !== actual.database) refused();
  } else if (actual.type === 'sftp') {
    if (!only(spec, ['type', 'host', 'port', 'path_prefix']) || normalizedHost(spec.host) !== actual.host || spec.port !== actual.port ||
        typeof spec.path_prefix !== 'string' || !spec.path_prefix.startsWith('/') || spec.path_prefix !== posix.normalize(spec.path_prefix) ||
        !(actual.path_prefix === spec.path_prefix || actual.path_prefix.startsWith(spec.path_prefix.replace(/\/$/, '') + '/'))) refused();
  } else if (actual.type === 's3') {
    if (!only(spec, ['type', 'endpoint', 'bucket', 'prefix']) || spec.endpoint !== actual.endpoint || spec.bucket !== actual.bucket ||
        typeof spec.prefix !== 'string' || !actual.prefix.startsWith(spec.prefix)) refused();
  } else if (!only(spec, ['type', 'path']) || spec.path !== actual.path) refused();
  return actual;
}
