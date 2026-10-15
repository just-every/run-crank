import { MailValidationError, fail } from '../core/errors.mjs';
import { parseAddress, validateMessage } from '../core/validation.mjs';

const oneClickPost = 'List-Unsubscribe=One-Click';

function rejectIfUnsafeEncoding(value) {
  let decoded = value;
  for (let depth = 0; depth < 32; depth += 1) {
    if (/[\r\n<>]/.test(decoded) || /%(?:0a|0d|3c|3e)/i.test(decoded)) return true;
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === decoded) break;
    decoded = next;
  }
  return false;
}

function validateHttpsUrl(value, errorCode = 'invalid_unsubscribe_url') {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value) || /%(?![0-9a-f]{2})/i.test(value) || rejectIfUnsafeEncoding(value)) {
    fail(errorCode);
  }

  let url;
  try { url = new URL(value); } catch { fail(errorCode); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) fail(errorCode);
  return value;
}

function mailboxFromMailto(value, errorCode = 'invalid_unsubscribe_mailto') {
  if (typeof value !== 'string') fail(errorCode);
  const mailbox = value.startsWith('mailto:') ? value.slice('mailto:'.length) : value;
  if (!mailbox || /[\x00-\x20\x7f]/.test(mailbox) || rejectIfUnsafeEncoding(mailbox)) fail(errorCode);

  const parsed = parseAddress(mailbox);
  if (parsed.name || parsed.email !== mailbox) fail(errorCode);
  return parsed.email;
}

function validateListUri(uri) {
  if (!uri || /[\x00-\x20\x7f]/.test(uri) || /%(?![0-9a-f]{2})/i.test(uri) || rejectIfUnsafeEncoding(uri)) {
    fail('invalid_list_unsubscribe');
  }

  if (/^https:/i.test(uri)) {
    validateHttpsUrl(uri, 'invalid_list_unsubscribe');
    return 'https';
  }
  if (/^mailto:/i.test(uri)) {
    mailboxFromMailto(uri.slice('mailto:'.length), 'invalid_list_unsubscribe');
    return 'mailto';
  }
  fail('invalid_list_unsubscribe');
}

function parseListUnsubscribe(value) {
  if (typeof value !== 'string' || !value) fail('invalid_list_unsubscribe');

  const schemes = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (value[cursor] === ' ') cursor += 1;
    if (value[cursor] !== '<') fail('invalid_list_unsubscribe');

    const close = value.indexOf('>', cursor + 1);
    if (close < 0) fail('invalid_list_unsubscribe');
    schemes.push(validateListUri(value.slice(cursor + 1, close)));
    cursor = close + 1;

    while (value[cursor] === ' ') cursor += 1;
    if (cursor === value.length) break;
    if (value[cursor] !== ',') fail('invalid_list_unsubscribe');
    cursor += 1;
    while (value[cursor] === ' ') cursor += 1;
    if (cursor === value.length) fail('invalid_list_unsubscribe');
  }

  if (!schemes.length) fail('invalid_list_unsubscribe');
  return schemes;
}

function header(headers, name) {
  const lowerName = name.toLowerCase();
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === lowerName);
  return key === undefined ? undefined : { key, value: headers[key] };
}

function validateExistingListHeaders(headers) {
  const list = header(headers, 'List-Unsubscribe');
  const post = header(headers, 'List-Unsubscribe-Post');
  if (!list) {
    if (post) fail('invalid_list_unsubscribe_post');
    return;
  }

  const schemes = parseListUnsubscribe(list.value);
  if (post && (post.value !== oneClickPost || !schemes.includes('https'))) fail('invalid_list_unsubscribe_post');
}

function addOrCheckHeader(headers, name, expected) {
  const existing = header(headers, name);
  if (existing) {
    if (existing.value !== expected) fail('unsubscribe_header_conflict');
    return;
  }
  headers[name] = expected;
}

function assemble(message) {
  validateMessage(message);

  const headers = { ...(message.headers ?? {}) };
  validateExistingListHeaders(headers);

  if (message.unsubscribe !== undefined) {
    const unsubscribe = message.unsubscribe;
    const url = validateHttpsUrl(unsubscribe.url);
    const uris = [`<${url}>`];
    if (unsubscribe.mailto !== undefined) uris.push(`<mailto:${mailboxFromMailto(unsubscribe.mailto)}>`);
    addOrCheckHeader(headers, 'List-Unsubscribe', uris.join(', '));

    const post = header(headers, 'List-Unsubscribe-Post');
    if (unsubscribe.oneClick === true) {
      addOrCheckHeader(headers, 'List-Unsubscribe-Post', oneClickPost);
    } else if (post) {
      fail('unsubscribe_header_conflict');
    }
  }

  const prepared = { ...message, headers };
  delete prepared.unsubscribe;
  validateMessage(prepared);
  return prepared;
}

/** Return a copy with validated unsubscribe headers assembled and the request consumed. */
export function applyUnsubscribeHeaders(message) {
  try {
    return assemble(message);
  } catch (error) {
    if (error instanceof MailValidationError) throw error;
    fail('invalid_message');
  }
}
