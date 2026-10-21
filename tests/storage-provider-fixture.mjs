// Real, disposable provider edges. No gateway adapter imports and no network fakes.
// Image configuration: linuxserver/docker-openssh-server README and
// docs.rustfs.com/en/installation/container/docker (checked 22 October 2026).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../gateways/node/package.json', import.meta.url));
const { Client, utils } = require('ssh2');
export const fixture = number => `synthetic-crank-${number}`;
const docker = process.env.CRANK_DOCKER ?? 'docker';
const privateValues = [];
export const registerPrivate = value => { if (value) privateValues.push(value, JSON.stringify(value).slice(1, -1)); };
export const sanitized = value => privateValues.reduce((text, secret) => text.replaceAll(secret, '[private fixture value]'), String(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const fingerprint = bytes => 'SHA256:' + createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');

export function command(binary, args, { input, timeout = 30000, signal, expected = 0, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '', bounded = false;
    const timer = setTimeout(() => { bounded = true; child.kill('SIGKILL'); }, timeout);
    const collect = target => bytes => {
      if (stdout.length + stderr.length + bytes.length > 128 * 1024) { bounded = true; child.kill('SIGKILL'); return; }
      if (target === 'stdout') stdout += bytes; else stderr += bytes;
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Owned command could not start (${error.code ?? error.name}).`)); });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      if (bounded || exitSignal) return reject(new Error('Owned command exceeded its bound or was interrupted.'));
      if (expected !== null && code !== expected) return reject(new Error(`Owned command failed (${code}): ${sanitized(stderr)}`));
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

// Independently sign setup PUTs with their actual body hash. Production signs
// empty GET/HEAD bodies; importing its signer would make setup circular proof.
function signedPut(connection, path, body, signal) {
  const endpoint = new URL(connection.endpoint), date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), day = date.slice(0, 8);
  const scope = `${day}/${connection.region}/s3/aws4_request`, payload = hash(body);
  const headers = { host: endpoint.host, 'x-amz-content-sha256': payload, 'x-amz-date': date };
  const names = Object.keys(headers).sort().join(';');
  const canonical = ['PUT', path, '', Object.keys(headers).sort().map(name => `${name}:${headers[name]}\n`).join(''), names, payload].join('\n');
  const key = [day, connection.region, 's3', 'aws4_request'].reduce((key, part) => hmac(key, part), 'AWS4' + connection.secretAccessKey);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${connection.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${hmac(key, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString('hex')}`;
  headers['content-length'] = String(body.length);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: endpoint.hostname, port: endpoint.port, path, method: 'PUT', headers, signal, agent: false }, response => {
      let count = 0;
      response.on('data', chunk => { count += chunk.length; if (count > 65536) response.destroy(new Error('Setup response exceeded bound.')); });
      response.once('error', reject);
      response.once('end', () => resolve(response.statusCode));
    });
    request.setTimeout(3000, () => request.destroy(new Error('Setup PUT timed out.')));
    request.once('error', reject); request.end(body);
  });
}

export function storageProviders(signal) {
  const owned = [];
  const sftp = { kind: 'sftp', image: 'lscr.io/linuxserver/openssh-server:latest', privatePort: 2222, path: '/config/' + fixture(14) + '.txt' };
  const s3 = { kind: 's3', image: 'rustfs/rustfs:latest', privatePort: 9000, bucket: fixture(26), key: fixture(27) + ' 雪.txt' };
  const providers = [sftp, s3];
  const run = (args, options = {}) => command(docker, args, { signal, ...options });
  const exec = (provider, args, options = {}) => run(['exec', ...(options.input === undefined ? [] : ['--interactive']), provider.id, ...args], options);
  // Real per-invocation SSH keys stay only in memory/private manifest. All
  // account names, access credentials and resource names are synthetic-crank-N.
  const key = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
  const privateKey = key(), refusedKey = key(); registerPrivate(privateKey); registerPrivate(refusedKey);
  const publicKey = 'ssh-rsa ' + utils.parseKey(privateKey).getPublicSSH().toString('base64');
  sftp.connection = { host: '127.0.0.1', username: fixture(11), privateKey };
  sftp.refusedKey = refusedKey;
  s3.connection = { region: 'us-east-1', accessKeyId: fixture(23), secretAccessKey: fixture(25), allowInsecureLoopback: true };
  for (const value of [sftp.connection.username, s3.connection.accessKeyId, s3.connection.secretAccessKey]) registerPrivate(value);
  const objectPath = () => '/' + s3.bucket + '/' + encodeURIComponent(s3.key).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());

  async function create(provider) {
    await run(['pull', '--quiet', provider.image], { timeout: 240000 });
    provider.name = fixture(provider.kind === 'sftp' ? 70 : 71) + '-' + randomUUID();
    const environment = provider === sftp ? ['PUID=1000', 'PGID=1000', 'TZ=Etc/UTC', 'USER_NAME=' + sftp.connection.username,
      'PUBLIC_KEY=' + publicKey, 'USER_PASSWORD=' + fixture(12), 'PASSWORD_ACCESS=false', 'SUDO_ACCESS=false'] :
      ['RUSTFS_ACCESS_KEY=' + s3.connection.accessKeyId, 'RUSTFS_SECRET_KEY=' + s3.connection.secretAccessKey,
        'RUSTFS_ADDRESS=:9000', 'RUSTFS_CONSOLE_ENABLE=false', 'RUSTFS_OBS_LOGGER_LEVEL=error'];
    registerPrivate(fixture(12)); registerPrivate(fixture(35));
    const args = ['create', '--name', provider.name, '--memory', provider === sftp ? '256m' : '768m', '--cpus', '1', '--pids-limit', '128',
      '--publish', `127.0.0.1::${provider.privatePort}`, '--tmpfs', provider === sftp ? '/config:rw,nosuid,size=32m' : '/data:rw,nosuid,size=128m,uid=10001,gid=10001',
      ...environment.flatMap(value => ['--env', value]), provider.image, ...(provider === s3 ? ['/data'] : [])];
    const created = await run(args); provider.id = created.stdout.trim();
    assert.match(provider.id, /^[a-f0-9]{64}$/); owned.push(provider.id);
    await run(['start', provider.id]);
    const port = (await run(['port', provider.id, provider.privatePort + '/tcp'])).stdout.trim();
    assert.match(port, /^127\.0\.0\.1:\d+$/, 'provider must be published only on loopback');
    provider.port = Number(port.split(':')[1]);
    provider.imageId = (await run(['inspect', '--format', '{{.Image}}', provider.id])).stdout.trim();
    if (provider === sftp) sftp.connection.port = provider.port;
    else s3.connection.endpoint = 'http://127.0.0.1:' + provider.port;
  }

  async function waitFor(label, probe) {
    const deadline = Date.now() + 120000;
    while (true) {
      signal?.throwIfAborted();
      if (await probe()) return;
      if (Date.now() >= deadline) throw new Error(`${label} did not become ready within two minutes.`);
      await delay(500, undefined, { signal });
    }
  }

  async function inspectSftp() {
    // Read only public host keys from our exact container, never provider logs or
    // private host keys. Negotiate against that trusted set, then pin the key
    // selected by the real server for both independent setup and gateway reads.
    const keys = await exec(sftp, ['sh', '-c', 'cat /config/ssh_host_keys/ssh_host_*_key.pub'], { expected: null });
    if (keys.code !== 0) return false;
    const trusted = new Set(keys.stdout.trim().split('\n').map(line => fingerprint(Buffer.from(line.split(/\s+/)[1], 'base64'))));
    return await new Promise(resolve => {
      const client = new Client(); let settled = false;
      const timer = setTimeout(() => finish(false), 2500);
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); client.destroy(); resolve(value); } };
      const aborted = () => finish(false);
      signal?.addEventListener('abort', aborted, { once: true });
      client.once('close', () => signal?.removeEventListener('abort', aborted));
      client.once('error', () => finish(false));
      client.once('ready', () => { client.sftp((error, channel) => { if (error) return finish(false); channel.stat('/config', error => finish(!error)); }); });
      client.connect({ ...sftp.connection, readyTimeout: 1500, authHandler: ['publickey'], hostVerifier: bytes => {
        const selected = fingerprint(bytes); if (!trusted.has(selected)) return false;
        sftp.connection.hostKeySha256 = selected; return true;
      } });
    });
  }

  async function put(provider, bytes, { preserveMetadata = false } = {}) {
    if (provider === s3) { assert.equal(await signedPut(s3.connection, objectPath(), bytes, signal), 200, 'real S3 provider must accept independently signed object PUT'); return; }
    const metadata = async () => (await exec(sftp, ['stat', '-c', '%s:%Y:%a:%u:%g', sftp.path])).stdout.trim();
    const before = preserveMetadata ? await metadata() : undefined;
    const script = preserveMetadata ? 'touch -r "$1" "$2" && cat > "$1" && touch -r "$2" "$1" && rm "$2"' : 'cat > "$1" && chmod 644 "$1"';
    await exec(sftp, ['sh', '-c', script, '--', sftp.path, '/tmp/' + fixture(15)], { input: bytes });
    if (preserveMetadata) assert.equal(await metadata(), before, 'mutation must preserve SFTP size/mtime/mode/uid/gid so cursor rejection proves content digest');
  }

  return {
    providers, put,
    async start(bytes) {
      const creates = await Promise.allSettled(providers.map(create));
      for (const result of creates) if (result.status === 'rejected') throw result.reason;
      const ready = await Promise.allSettled([
        waitFor('OpenSSH SFTP', inspectSftp),
        waitFor('RustFS S3', async () => {
          let status;
          try { status = await signedPut(s3.connection, '/' + s3.bucket, Buffer.alloc(0), signal); }
          catch { signal?.throwIfAborted(); return false; }
          if (status === 200) return true;
          assert([429, 500, 502, 503, 504].includes(status), `Real S3 bucket setup refused independently signed PUT (HTTP ${status}).`);
          return false;
        }),
      ]);
      for (const result of ready) if (result.status === 'rejected') throw result.reason;
      await Promise.all(providers.map(provider => put(provider, bytes)));
    },
    async close() {
      // Ignore the aborted journey signal. Names only recover an interrupted
      // acknowledgement; removals always address the exact ID of our create.
      const failures = [];
      for (const provider of providers.filter(provider => provider.name && !provider.id)) {
        try {
          const recovered = await command(docker, ['inspect', '--type=container', '--format', '{{.Id}}', provider.name], { expected: null });
          if (recovered.code === 0) { const id = recovered.stdout.trim(); assert.match(id, /^[a-f0-9]{64}$/); owned.push(id); }
          else if (!/No such (object|container)/i.test(recovered.stderr)) throw new Error('Could not recover owned container for cleanup: ' + sanitized(recovered.stderr));
        } catch (error) { failures.push(error); }
      }
      const removed = await Promise.allSettled([...new Set(owned)].map(id => command(docker, ['rm', '--force', '--volumes', id])));
      for (const result of removed) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, 'Owned provider cleanup failed.');
    },
  };
}
