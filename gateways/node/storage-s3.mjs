import http from 'node:http';
import https from 'node:https';
import { fail } from './errors.mjs';
import { encodeS3Path, signedHeaders } from './storage-sigv4.mjs';
import { CHUNK_BYTES, MAX_SOURCE_BYTES, changed, identity, scanLines } from './storage-lines.mjs';

const refused = () => fail('execution_failed', 'S3 endpoint must support consistent conditional, exact byte-range reads without redirects.');

// Node's request API never follows redirects, forwards credentials, decompresses
// responses, retries requests, or consults proxy/credential-chain environment.
async function request(op, method, extra, signal) {
  const endpoint = new URL(op.connection.endpoint);
  const path = encodeS3Path(`/${op.bucket}/${op.key}`);
  return await new Promise((resolve, reject) => {
    const req = (endpoint.protocol === 'https:' ? https : http).request({
      protocol: endpoint.protocol, hostname: endpoint.hostname.replace(/^\[|\]$/g, ''), port: endpoint.port || undefined,
      method, path, headers: signedHeaders(op.connection, endpoint, method, path, extra),
      signal, agent: false, maxHeaderSize: 16384, highWaterMark: CHUNK_BYTES,
      // A cleartext localhost exception must never resolve beyond loopback.
      ...(endpoint.protocol === 'http:' && endpoint.hostname === 'localhost' ?
        { lookup: (_host, options, callback) => callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4) } : {}),
    }, response => {
      // Keep an observer until the body iterator attaches; never log raw errors.
      response.on('error', () => {});
      resolve(response);
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Storage socket timeout.')));
    req.end();
  });
}

function metadata(response) {
  const headers = response.headers;
  const rawSize = headers['content-length'];
  const size = typeof rawSize === 'string' && /^(0|[1-9][0-9]*)$/.test(rawSize) ? Number(rawSize) : NaN;
  const etag = headers.etag, modified = headers['last-modified'];
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SOURCE_BYTES) {
    fail('output_limit', 'Configured S3 source must declare a size within 64 MiB.');
  }
  if (typeof etag !== 'string' || !/^"[\x21\x23-\x7e]{1,256}"$/.test(etag) ||
      typeof modified !== 'string' || modified.length > 128 || !Number.isFinite(Date.parse(modified)) ||
      (headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity')) refused();
  return { size, etag, modified };
}

async function head(op, signal, etag) {
  const response = await request(op, 'HEAD', etag ? { 'if-match': etag } : {}, signal);
  try {
    if (response.statusCode === 412) changed();
    if (response.statusCode !== 200 || response.headers['content-range'] !== undefined) refused();
    const result = metadata(response);
    for await (const bytes of response) { if (bytes.length) refused(); }
    if (!response.complete) refused();
    return result;
  } finally { response.destroy(); }
}

async function* body(response) {
  for await (const chunk of response) {
    for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) yield chunk.subarray(offset, offset + CHUNK_BYTES);
  }
  if (!response.complete) refused();
}

export async function s3Lines(op, input, signal) {
  const before = await head(op, signal);
  const source = identity({ type: op.type, destination: op.destination, endpoint: new URL(op.connection.endpoint).origin,
    region: op.connection.region, bucket: op.bucket, key: op.key, ...before });
  let response;
  try {
    let chunks = [];
    if (before.size) {
      response = await request(op, 'GET', { 'if-match': before.etag, range: `bytes=0-${before.size - 1}` }, signal);
      if (response.statusCode === 412) changed();
      if (response.statusCode !== 206 || response.headers['content-range'] !== `bytes 0-${before.size - 1}/${before.size}`) refused();
      if (identity(metadata(response)) !== identity(before)) changed();
      chunks = body(response);
    }
    const output = await scanLines(chunks, before.size, source, input, input.limit ?? op.pageLines, signal);
    if (identity(await head(op, signal, before.etag)) !== identity(before)) changed();
    return output;
  } finally { response?.destroy(); }
}
