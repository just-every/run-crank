import { fail } from '../../core/errors.mjs';
import { encodeBase64, parseAddress, validateMessage } from '../../core/validation.mjs';
import { assertResendMessageSize, assertResendRequestSize } from './size.mjs';

function mailbox(value) {
  const { email, name } = parseAddress(value);
  // Quote names containing mailbox delimiters so one address remains one address.
  return name ? `${/[(),:;@\[\]]/.test(name) ? `"${name}"` : name} <${email}>` : email;
}

export function serializeResendMessage(message) {
  if (message && Object.hasOwn(message, 'unsubscribe')) fail('unsubscribe_requires_facade');
  validateMessage(message, 'resend');
  // Preserve the exact key across Fetch's header normalization. No hashing/truncation.
  if (!/^[\x20-\x7e]{1,256}$/.test(message.deliveryId) || message.deliveryId.trim() !== message.deliveryId) fail('invalid_resend_idempotency_key');
  if (message.to.length > 50) fail('resend_recipient_limit');
  assertResendMessageSize(message);
  for (const name in message.headers) {
    if (!Object.hasOwn(message.headers, name)) continue;
    if (['idempotency-key', 'resend-idempotency-key'].includes(name.toLowerCase())) fail('reserved_resend_header');
  }
  const attachments = message.attachments?.map(attachment => {
    // Resend derives inline disposition from content_id; no independent disposition exists.
    if (attachment.disposition === 'attachment' && attachment.contentId !== undefined) fail('unsupported_resend_attachment_disposition');
    return {
      filename: attachment.filename,
      content: encodeBase64(attachment.content),
      content_type: attachment.contentType,
      ...(attachment.contentId === undefined ? {} : { content_id: attachment.contentId }),
    };
  });
  const body = JSON.stringify({
    from: mailbox(message.from),
    to: message.to.map(mailbox),
    subject: message.subject,
    ...(message.text === undefined ? {} : { text: message.text }),
    ...(message.html === undefined ? {} : { html: message.html }),
    ...(message.cc === undefined ? {} : { cc: message.cc.map(mailbox) }),
    ...(message.bcc === undefined ? {} : { bcc: message.bcc.map(mailbox) }),
    ...(message.replyTo === undefined ? {} : { reply_to: mailbox(message.replyTo) }),
    ...(message.headers === undefined ? {} : { headers: message.headers }),
    ...(attachments === undefined ? {} : { attachments }),
  });
  assertResendRequestSize(body);
  return body;
}
