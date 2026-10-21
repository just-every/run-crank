import { fail, isObject } from './errors.mjs';

const fields = {
  'postgres-command': ['user', 'password'], 'postgres-query': ['user', 'password'], 'mysql-query': ['user', 'password'], 'sqlserver-query': ['user', 'password'],
  'sftp-lines': ['username', 'password', 'privateKey', 'passphrase'],
  's3-lines': ['accessKeyId', 'secretAccessKey', 'sessionToken'],
};
const allSecrets = new Set(Object.values(fields).flat());
export function withCredentials(manifest, op) {
  const allowed = fields[op.type];
  if (!allowed) return op;
  if (typeof op.credential !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(op.credential) ||
      !isObject(manifest.credentials) || !Object.hasOwn(manifest.credentials, op.credential) || !isObject(op.connection) ||
      Object.keys(op.connection).some(key => allSecrets.has(key))) {
    fail('configuration', 'Remote operations require a named local credential and separate destination configuration.');
  }
  const credential = manifest.credentials[op.credential];
  if (!isObject(credential) || !Object.keys(credential).length || Object.keys(credential).some(key => !allowed.includes(key))) {
    fail('configuration', 'Named local credential has invalid fields.');
  }
  return { ...op, connection: { ...op.connection, ...credential } };
}
