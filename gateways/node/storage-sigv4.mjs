import { createHash, createHmac } from 'node:crypto';

// S3's canonical URI is encoded bytewise and never path-normalized. See:
// https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
export const encodeS3Path = value => [...Buffer.from(value, 'utf8')].map(byte =>
  (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) ||
  [45, 46, 47, 95, 126].includes(byte) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');

export function signedHeaders(connection, endpoint, method, path, extra, now = new Date()) {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const headers = { host: endpoint.host, 'x-amz-date': date, 'x-amz-content-sha256': sha256(''), ...extra };
  if (connection.sessionToken !== undefined) headers['x-amz-security-token'] = connection.sessionToken;
  const names = Object.keys(headers).sort();
  const canonical = [method, path, '', names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''),
    names.join(';'), headers['x-amz-content-sha256']].join('\n');
  const scope = `${day}/${connection.region}/s3/aws4_request`;
  let key = hmac(`AWS4${connection.secretAccessKey}`, day);
  key = hmac(key, connection.region); key = hmac(key, 's3'); key = hmac(key, 'aws4_request');
  const signature = hmac(key, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonical)}`).toString('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${connection.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return headers;
}
