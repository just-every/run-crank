import { GatewayError, fail, isObject } from './errors.mjs';
import { sftpLines } from './storage-sftp.mjs';
import { s3Lines } from './storage-s3.mjs';

const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max;
const plain = (value, max = 4096) => text(value, max) && !/[\x00-\x20\x7f]/.test(value);
const only = (object, keys) => Object.keys(object).every(key => keys.includes(key));
const invalid = () => fail('configuration', 'Invalid private storage operation configuration.');

// All connection material belongs in the existing mode-0600 gateway manifest.
// There is no environment/credential-chain lookup and no task-supplied location.
export function validateStorage(op) {
  if (!isObject(op) || !['sftp-lines', 's3-lines'].includes(op.type) ||
      !Number.isInteger(op.pageLines) || op.pageLines < 1 || op.pageLines > 1000 ||
      !isObject(op.connection) || !isObject(op.parameters) ||
      !only(op.parameters, ['cursor', 'limit']) ||
      (Object.hasOwn(op.parameters, 'cursor') && (!isObject(op.parameters.cursor) || op.parameters.cursor.type !== 'string' || op.parameters.cursor.optional !== true)) ||
      (Object.hasOwn(op.parameters, 'limit') && (!isObject(op.parameters.limit) || op.parameters.limit.type !== 'integer' || op.parameters.limit.optional !== true))) invalid();
  const c = op.connection;
  if (op.type === 'sftp-lines') {
    if (!only(c, ['host', 'port', 'username', 'hostKeySha256', 'password', 'privateKey', 'passphrase']) ||
        !plain(c.host, 253) || /[\/@?#]/.test(c.host) || !plain(c.username, 256) ||
        !Number.isInteger(c.port) || c.port < 1 || c.port > 65535 ||
        !/^SHA256:[A-Za-z0-9+/]{43}$/.test(c.hostKeySha256 ?? '') ||
        Buffer.from(c.hostKeySha256.slice(7), 'base64').toString('base64').replace(/=+$/, '') !== c.hostKeySha256.slice(7) ||
        (c.password === undefined) === (c.privateKey === undefined) ||
        (c.password !== undefined && !text(c.password)) ||
        (c.privateKey !== undefined && !text(c.privateKey, 65536)) ||
        (c.passphrase !== undefined && (c.privateKey === undefined || !text(c.passphrase))) ||
        !text(op.path) || !op.path.startsWith('/') || op.path.includes('\0')) invalid();
  } else {
    if (!only(c, ['endpoint', 'region', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'allowInsecureLoopback']) ||
        !plain(c.endpoint, 2048) || !/^[A-Za-z0-9-]{1,64}$/.test(c.region ?? '') ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(c.accessKeyId ?? '') || !plain(c.secretAccessKey) ||
        (c.sessionToken !== undefined && !plain(c.sessionToken, 8192)) ||
        (c.allowInsecureLoopback !== undefined && typeof c.allowInsecureLoopback !== 'boolean') ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(op.bucket ?? '') ||
        !text(op.key, 1024) || Buffer.byteLength(op.key) > 1024 || op.key.includes('\0') || !op.key.isWellFormed()) invalid();
    let endpoint;
    try { endpoint = new URL(c.endpoint); } catch { invalid(); }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
        (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && c.allowInsecureLoopback === true &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)))) invalid();
  }
  return op;
}

export async function executeStorage(op, input) {
  validateStorage(op);
  if (!isObject(input) || !only(input, ['cursor', 'limit']) ||
      Object.keys(input).some(key => !Object.hasOwn(op.parameters, key)) ||
      (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 1024)) ||
      (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > op.pageLines))) {
    fail('invalid_input', 'Storage accepts only its optional bounded cursor and limit.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new GatewayError('execution_failed', 'Storage operation exceeded its time bound.')), 4000);
  try {
    return await (op.type === 'sftp-lines' ? sftpLines(op, input, controller.signal) : s3Lines(op, input, controller.signal));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
      fail('execution_failed', 'Install the private gateway package dependencies before using SFTP.');
    }
    fail('execution_failed', 'Configured storage source could not be read consistently as UTF-8.');
  } finally { clearTimeout(timer); }
}
