import { fail } from './errors.mjs';
import { validateMessagingConfig, validateMessagingResult, identity, rfc3339 } from '../adapters/messaging/contract.mjs';
import { validateRerConfig, validateRerMessage, validateRerMessageKey } from '../adapters/rer/contract.mjs';
import { rerListHeaderField } from '../adapters/rer/list-headers.mjs';

const providers = ['sendgrid', 'resend', 'cloudflare', 'rer', 'development', 'messaging'];
const controls = /[\x00-\x1f\x7f]/;
const fields = new Set(['deliveryId', 'from', 'to', 'subject', 'text', 'html', 'cc', 'bcc', 'replyTo', 'headers', 'attachments', 'unsubscribe', 'customArgs', 'asmGroupId', 'subscriptionTracking', 'kind', 'expiresAt', 'messageKey']);
const reservedHeaders = new Set(['x-sg-id', 'x-sg-eid', 'received', 'dkim-signature', 'content-type', 'content-transfer-encoding', 'mime-version', 'to', 'from', 'subject', 'reply-to', 'cc', 'bcc', 'return-path', 'sender']);
const reservedArgs = new Set(['rer_delivery_id', 'email', 'event', 'timestamp', 'sg_event_id', 'sg_message_id']);

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  return value;
}
function keys(value, allowed, code) {
  record(value, code);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) fail(code);
}
function bounded(value, limit, code, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit || controls.test(value)) fail(code);
}

export function validateConfig(config, dependencies = {}) {
  keys(config, new Set(['provider', 'mode', 'apiKey', 'accountId', 'relayUrl', 'serviceOrigin', 'installId', 'kid', 'signingKey']), 'invalid_config');
  record(dependencies, 'invalid_dependencies');
  if (!providers.includes(config.provider)) fail('invalid_provider');
  if (!['production', 'development', 'test'].includes(config.mode)) fail('invalid_mode');
  if (dependencies.fetch !== undefined && typeof dependencies.fetch !== 'function') fail('invalid_fetch');
  if (dependencies.clock !== undefined && typeof dependencies.clock !== 'function') fail('invalid_clock');
  if (dependencies.timeoutMilliseconds !== undefined &&
      (!Number.isSafeInteger(dependencies.timeoutMilliseconds) || dependencies.timeoutMilliseconds <= 0)) fail('invalid_timeout');
  if (config.provider === 'rer') validateRerConfig(config);
  else if (config.relayUrl !== undefined) fail('unsupported_provider_setting');
  if (config.provider === 'messaging') return validateMessagingConfig(config, dependencies) ?? config;
  if (['serviceOrigin', 'installId', 'kid', 'signingKey'].some(field => config[field] !== undefined) || dependencies.serviceBinding !== undefined) fail('unsupported_provider_setting');
  if (config.provider === 'development') {
    if (config.mode !== 'development') fail('development_mode_required');
    if (config.apiKey !== undefined || config.accountId !== undefined) fail('unsupported_development_config');
  } else {
    if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) fail('api_key_required');
    bounded(config.apiKey, 4096, 'invalid_api_key');
    if (/\s/.test(config.apiKey)) fail('invalid_api_key');
    if (config.provider === 'cloudflare') {
      if (typeof config.accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(config.accountId)) fail('cloudflare_account_required');
    } else if (config.accountId !== undefined) fail('unsupported_account_id');
  }
  return config;
}

export function parseAddress(value) {
  bounded(value, 998, 'invalid_address');
  const match = value.trim().match(/^(?:(.*?)\s*<([^<>]+)>|([^<>]+))$/u);
  const email = (match?.[2] ?? match?.[3] ?? '').trim();
  // Conservative mailbox subset; never serialize multiple mailboxes as one.
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || email.length > 254 ||
      !/^[^\s@<>(),:;"\\]+$/u.test(parts[0]) || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..') ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(parts[1])) fail('invalid_address');
  let name = match?.[1]?.trim();
  if (name?.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  if (name && /[<>"\\]/.test(name)) fail('invalid_address');
  return name ? { email, name } : { email };
}

export function validateHeaders(headers = {}, provider) {
  record(headers, 'invalid_headers');
  const names = new Set();
  for (const name of Reflect.ownKeys(headers)) {
    if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || name.length > 998) fail('invalid_header_name');
    const lower = name.toLowerCase();
    if (reservedHeaders.has(lower) || names.has(lower)) fail('reserved_or_duplicate_header');
    names.add(lower);
    // These relay grammars allow separator tabs and report field-specific errors.
    if (provider === 'rer' && rerListHeaderField(lower, headers[name])) continue;
    bounded(headers[name], 8192, 'invalid_header_value', true);
  }
  return headers;
}

function addresses(values, required = false) {
  if (!Array.isArray(values) || (required && !values.length)) fail('invalid_recipients');
  for (const value of values) parseAddress(value);
}
function validateAttachment(attachment) {
  keys(attachment, new Set(['filename', 'contentType', 'content', 'disposition', 'contentId']), 'invalid_attachment');
  bounded(attachment.filename, 998, 'invalid_attachment_filename');
  bounded(attachment.contentType, 255, 'invalid_attachment_content_type');
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(attachment.contentType)) fail('invalid_attachment_content_type');
  if (!(attachment.content instanceof Uint8Array)) fail('invalid_attachment_content');
  if (attachment.disposition !== undefined && !['attachment', 'inline'].includes(attachment.disposition)) fail('invalid_attachment_disposition');
  if (attachment.contentId !== undefined) {
    bounded(attachment.contentId, 998, 'invalid_attachment_content_id');
    if (/[\s<>]/.test(attachment.contentId)) fail('invalid_attachment_content_id');
  }
  if (attachment.disposition === 'inline' && !attachment.contentId) fail('inline_content_id_required');
}
function validateUnsubscribe(value) {
  keys(value, new Set(['url', 'mailto', 'oneClick']), 'invalid_unsubscribe');
  bounded(value.url, 8192, 'invalid_unsubscribe_url');
  let url;
  try { url = new URL(value.url); } catch { fail('invalid_unsubscribe_url'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || /[<>]/.test(value.url) || /%0[ad]/i.test(value.url)) fail('invalid_unsubscribe_url');
  if (value.mailto !== undefined) {
    const mailbox = value.mailto.startsWith?.('mailto:') ? value.mailto.slice(7) : value.mailto;
    const parsed = parseAddress(mailbox);
    if (parsed.name || parsed.email !== mailbox) fail('invalid_unsubscribe_mailto');
  }
  if (value.oneClick !== undefined && typeof value.oneClick !== 'boolean') fail('invalid_unsubscribe_one_click');
}

export function validateMessage(message, provider) {
  keys(message, fields, 'invalid_message');
  if (provider !== undefined && !providers.includes(provider)) fail('invalid_provider');
  bounded(message.deliveryId, 512, 'invalid_delivery_id');
  if (provider === 'messaging') {
    identity(message.deliveryId, 512, 'invalid_delivery_id');
    if (message.deliveryId === '.' || message.deliveryId === '..') fail('invalid_delivery_id');
    try { encodeURIComponent(message.deliveryId); } catch { fail('invalid_delivery_id'); }
    if (!['auth', 'transactional', 'bulk'].includes(message.kind)) fail('invalid_message_kind');
    if (!Array.isArray(message.to) || message.to.length !== 1 || message.cc !== undefined || message.bcc !== undefined) fail('messaging_one_recipient_required');
    if (message.expiresAt !== undefined) rfc3339(message.expiresAt, 'invalid_message_expiry');
  } else if (provider !== undefined && (message.kind !== undefined || message.expiresAt !== undefined)) fail('unsupported_provider_setting');
  if (message.kind !== undefined && !['auth', 'transactional', 'bulk'].includes(message.kind)) fail('invalid_message_kind');
  if (message.expiresAt !== undefined) rfc3339(message.expiresAt, 'invalid_message_expiry');
  parseAddress(message.from);
  addresses(message.to, true);
  if (message.cc !== undefined) addresses(message.cc);
  if (message.bcc !== undefined) addresses(message.bcc);
  if (message.replyTo !== undefined) parseAddress(message.replyTo);
  bounded(message.subject, 998, 'invalid_subject', true);
  for (const field of ['text', 'html']) if (message[field] !== undefined && typeof message[field] !== 'string') fail('invalid_body');
  if (!message.text?.trim() && !message.html?.trim()) fail('body_required');
  if (message.headers !== undefined) validateHeaders(message.headers, provider);
  if (message.attachments !== undefined) {
    if (!Array.isArray(message.attachments)) fail('invalid_attachments');
    for (const attachment of message.attachments) validateAttachment(attachment);
  }
  if (message.unsubscribe !== undefined) validateUnsubscribe(message.unsubscribe);
  if (message.messageKey !== undefined) {
    // Only the rer relay assigns Message-IDs from keys; development accepts what rer accepts.
    if (provider !== undefined && !['rer', 'development'].includes(provider)) fail('unsupported_provider_setting');
    validateRerMessageKey(message.messageKey);
  }
  if (provider === 'rer') validateRerMessage(message);
  const settings = ['customArgs', 'asmGroupId', 'subscriptionTracking'];
  if (provider && !['sendgrid', 'development'].includes(provider) && settings.some(key => message[key] !== undefined)) fail('unsupported_provider_setting');
  if (message.asmGroupId !== undefined && (!Number.isSafeInteger(message.asmGroupId) || message.asmGroupId <= 0)) fail('invalid_asm_group');
  if (message.subscriptionTracking !== undefined && typeof message.subscriptionTracking !== 'boolean') fail('invalid_subscription_tracking');
  const args = message.customArgs ?? {};
  if (message.customArgs !== undefined) record(message.customArgs, 'invalid_custom_args');
  for (const key of Reflect.ownKeys(args)) {
    if (typeof key !== 'string' || !key || controls.test(key) || reservedArgs.has(key) || typeof args[key] !== 'string') fail('invalid_custom_arg');
  }
  if (new TextEncoder().encode(JSON.stringify({ ...args, rer_delivery_id: message.deliveryId })).byteLength > 10_000) fail('custom_args_too_large');
  return message;
}

export function encodeBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('invalid_attachment_content');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function validateSendResult(result, provider) {
  if (provider === 'messaging') return validateMessagingResult(result);
  keys(result, new Set(['provider', 'status', 'providerMessageId', 'code', 'recipientResults']), 'invalid_send_result');
  if (!providers.includes(provider) || result.provider !== provider || !['accepted', 'rejected', 'rate_limited', 'uncertain', 'development'].includes(result.status)) fail('invalid_send_result');
  if ((provider === 'development') !== (result.status === 'development')) fail('invalid_send_result');
  if (result.providerMessageId !== null) bounded(result.providerMessageId, 1024, 'invalid_provider_message_id');
  if (result.status === 'development' && result.providerMessageId !== null) fail('invalid_send_result');
  if (result.code !== undefined && (typeof result.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(result.code))) fail('invalid_result_code');
  if (result.recipientResults !== undefined) {
    if (!Array.isArray(result.recipientResults)) fail('invalid_recipient_results');
    for (const item of result.recipientResults) {
      keys(item, new Set(['recipient', 'status']), 'invalid_recipient_result');
      parseAddress(item.recipient);
      if (!['accepted', 'rejected', 'rate_limited', 'uncertain'].includes(item.status)) fail('invalid_recipient_status');
    }
  }
  return result;
}
