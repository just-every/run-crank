import { fail } from '../../core/errors.mjs';
import { parseAddress } from '../../core/validation.mjs';

// https://developers.cloudflare.com/email-service/reference/headers/
const allowed = new Set([
  'in-reply-to', 'references', 'thread-index', 'thread-topic', 'list-unsubscribe',
  'list-unsubscribe-post', 'list-id', 'list-archive', 'list-help', 'list-owner',
  'list-post', 'list-subscribe', 'precedence', 'auto-submitted', 'content-language',
  'keywords', 'comments', 'importance', 'priority', 'sensitivity', 'organization',
  'require-recipient-valid-since', 'expires', 'reply-by', 'archived-at',
]);
const values = {
  precedence: ['bulk', 'list', 'junk'],
  'auto-submitted': ['auto-generated', 'auto-replied', 'auto-notified'],
  importance: ['high', 'normal', 'low'],
  priority: ['normal', 'non-urgent', 'urgent'],
  sensitivity: ['personal', 'private', 'company-confidential'],
};

function unsubscribe(value) {
  const parts = value.split(',').map(part => part.trim());
  let https = false;
  for (const part of parts) {
    if (!/^<[^<>\s]+>$/.test(part)) fail('cloudflare_invalid_unsubscribe_header');
    const uri = part.slice(1, -1);
    if (/%0[ad]/i.test(uri)) fail('cloudflare_invalid_unsubscribe_header');
    if (uri.startsWith('https://')) {
      let url;
      try { url = new URL(uri); } catch { fail('cloudflare_invalid_unsubscribe_header'); }
      if (!url.hostname || url.username || url.password) fail('cloudflare_invalid_unsubscribe_header');
      https = true;
    } else if (uri.startsWith('mailto:')) {
      const address = uri.slice(7);
      const parsed = parseAddress(address);
      if (parsed.name || parsed.email !== address) fail('cloudflare_invalid_unsubscribe_header');
    } else fail('cloudflare_invalid_unsubscribe_header');
  }
  return https;
}

export function validateCloudflareHeaders(headers = {}) {
  const normalized = new Map();
  const encoder = new TextEncoder();
  let bytes = 0;
  let standardCount = 0;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const custom = /^x-[a-z0-9_-]+$/i.test(name);
    if (!custom && !allowed.has(lower)) fail('cloudflare_unsupported_header');
    if (name.length > 100) fail('cloudflare_invalid_header_name');
    const size = encoder.encode(value).byteLength;
    if (!value.trim() || size > 2048) fail('cloudflare_invalid_header_value');
    bytes += name.length + 4 + size;
    if (!custom) standardCount++;
    if (values[lower] && !values[lower].includes(value)) fail('cloudflare_invalid_header_value');
    normalized.set(lower, value);
  }
  if (bytes > 16 * 1024 || standardCount > 20) fail('cloudflare_headers_too_large');
  const list = normalized.get('list-unsubscribe');
  const hasHttps = list === undefined ? false : unsubscribe(list);
  const post = normalized.get('list-unsubscribe-post');
  if (post !== undefined && (post !== 'List-Unsubscribe=One-Click' || !hasHttps)) fail('cloudflare_invalid_unsubscribe_header');
}
