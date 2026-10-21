import { createHash, timingSafeEqual } from 'node:crypto';
import { GatewayError, fail } from './errors.mjs';
import { CHUNK_BYTES, MAX_SOURCE_BYTES, changed, identity, scanLines } from './storage-lines.mjs';

function invoke(sftp, method, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      sftp[method](...args, (error, result) => {
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      });
    } catch (error) {
      signal.removeEventListener('abort', abort);
      reject(error);
    }
  });
}

function metadata(stat) {
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_SOURCE_BYTES) {
    fail('output_limit', 'Configured SFTP source must be a regular file within 64 MiB.');
  }
  if (!Number.isSafeInteger(stat.mtime) || !Number.isSafeInteger(stat.mode)) {
    fail('execution_failed', 'SFTP server must provide stable source metadata.');
  }
  return { size: stat.size, mtime: stat.mtime, mode: stat.mode, uid: stat.uid, gid: stat.gid };
}

async function* chunks(sftp, handle, size, signal) {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let position = 0;
  while (position < size) {
    const count = Math.min(buffer.length, size - position);
    const bytesRead = await invoke(sftp, 'read', [handle, buffer, 0, count, position], signal);
    if (!Number.isInteger(bytesRead) || bytesRead < 1 || bytesRead > count) changed();
    yield buffer.subarray(0, bytesRead);
    position += bytesRead;
  }
}

export async function sftpLines(op, input, outerSignal) {
  const { Client } = (await import('ssh2')).default;
  const client = new Client();
  const controller = new AbortController();
  const { signal } = controller;
  const abort = () => { controller.abort(outerSignal.reason); client.destroy(); };
  const failed = () => controller.abort(new GatewayError('execution_failed', 'Configured SFTP connection failed.'));
  outerSignal.throwIfAborted();
  outerSignal.addEventListener('abort', abort, { once: true });
  client.on('error', failed);
  client.on('close', failed);
  try {
    const c = op.connection;
    const expected = Buffer.from(c.hostKeySha256.slice(7), 'base64');
    await new Promise((resolve, reject) => {
      const stopped = () => reject(signal.reason);
      signal.addEventListener('abort', stopped, { once: true });
      client.once('ready', () => { signal.removeEventListener('abort', stopped); resolve(); });
      client.connect({ host: c.host, port: c.port, username: c.username,
        ...(c.password !== undefined ? { password: c.password, authHandler: ['password'] } :
          { privateKey: c.privateKey, passphrase: c.passphrase, authHandler: ['publickey'] }),
        hostVerifier: key => timingSafeEqual(createHash('sha256').update(key).digest(), expected),
        readyTimeout: 3000, keepaliveInterval: 0, tryKeyboard: false, agentForward: false,
      });
    });
    const sftp = await invoke(client, 'sftp', [], signal);
    const handle = await invoke(sftp, 'open', [op.path, 'r'], signal);
    const before = metadata(await invoke(sftp, 'fstat', [handle], signal));
    const source = identity({ type: op.type, destination: op.destination, host: c.host, port: c.port,
      username: c.username, hostKeySha256: c.hostKeySha256, path: op.path, ...before });
    const output = await scanLines(chunks(sftp, handle, before.size, signal), before.size, source, input, input.limit ?? op.pageLines, signal);
    if (identity(metadata(await invoke(sftp, 'fstat', [handle], signal))) !== identity(before) ||
        identity(metadata(await invoke(sftp, 'stat', [op.path], signal))) !== identity(before)) changed();
    await invoke(sftp, 'close', [handle], signal);
    return output;
  } finally {
    outerSignal.removeEventListener('abort', abort);
    client.destroy();
  }
}
