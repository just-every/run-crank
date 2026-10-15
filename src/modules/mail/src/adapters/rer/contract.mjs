import { fail } from '../../core/errors.mjs';

// The relay's own List-Unsubscribe rule: one or two <https:…>/<mailto:…> entries.
const listEntries = /^[ \t]*<([^<>\s]+)>[ \t]*(?:,[ \t]*<([^<>\s]+)>[ \t]*)?$/;
const relayMailbox = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateRerConfig(config) {
  let url;
  try { url = new URL(config.relayUrl); } catch { fail('rer_relay_url_required'); }
  if (typeof config.relayUrl !== 'string' || url.protocol !== 'https:' ||
      url.username || url.password || config.relayUrl.includes('?') || config.relayUrl.includes('#') ||
      url.href !== config.relayUrl) fail('invalid_rer_relay_url');
}

/** Relay request fields for the headers it supports; it sets Auto-Submitted: auto-generated itself. */
export function rerHeaderFields(headers = {}) {
  const fields = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'auto-submitted') {
      if (value.trim().toLowerCase() !== 'auto-generated') fail('unsupported_provider_setting');
    } else if (lower === 'list-unsubscribe') fields.listUnsubscribe = value;
    else if (lower === 'list-unsubscribe-post') {
      if (value !== 'List-Unsubscribe=One-Click') fail('invalid_list_unsubscribe_post');
      fields.listUnsubscribePost = true;
    } else fail('unsupported_provider_setting');
  }
  let https = false;
  if (fields.listUnsubscribe !== undefined) {
    const entries = fields.listUnsubscribe.length <= 2000 && fields.listUnsubscribe.match(listEntries);
    if (!entries) fail('invalid_list_unsubscribe');
    for (const entry of entries.slice(1).filter(Boolean)) {
      if (/^https:\/\//i.test(entry)) https = true;
      else if (!/^mailto:/i.test(entry) || !relayMailbox.test(entry.slice(7))) fail('invalid_list_unsubscribe');
    }
  }
  if (fields.listUnsubscribePost && !https) fail('invalid_list_unsubscribe_post');
  return fields;
}

export function validateRerMessage(message) {
  if (message.to.length !== 1) fail('rer_one_recipient_required');
  // The relay cannot preserve these features. Refuse them rather than silently
  // dropping recipients, attachments or threading.
  if (['cc', 'bcc', 'replyTo', 'attachments'].some(field => message[field] !== undefined)) fail('unsupported_provider_setting');
  rerHeaderFields(message.headers);
  if (!message.subject.trim() || message.subject.length > 200) fail('invalid_subject');
  if (!message.text?.trim() || message.text.length > 65_536 ||
      (message.html !== undefined && message.html.length > 65_536)) fail('invalid_body');
}
