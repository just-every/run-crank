import { fail } from '../../core/errors.mjs';

export function validateRerConfig(config) {
  let url;
  try { url = new URL(config.relayUrl); } catch { fail('rer_relay_url_required'); }
  if (typeof config.relayUrl !== 'string' || url.protocol !== 'https:' ||
      url.username || url.password || config.relayUrl.includes('?') || config.relayUrl.includes('#') ||
      url.href !== config.relayUrl) fail('invalid_rer_relay_url');
}

export function validateRerMessage(message) {
  if (message.to.length !== 1) fail('rer_one_recipient_required');
  // The relay cannot preserve these features. Refuse them rather than silently
  // dropping recipients, attachments, threading or unsubscribe instructions.
  if (['cc', 'bcc', 'replyTo', 'attachments', 'unsubscribe'].some(field => message[field] !== undefined) ||
      (message.headers !== undefined && Reflect.ownKeys(message.headers).length > 0)) {
    fail('unsupported_provider_setting');
  }
  if (!message.subject.trim() || message.subject.length > 200) fail('invalid_subject');
  if (!message.text?.trim() || message.text.length > 65_536 ||
      (message.html !== undefined && message.html.length > 65_536)) fail('invalid_body');
}
