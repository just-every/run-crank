import { validateMessage, parseAddress, encodeBase64 } from '../../core/validation.mjs';
import { fail, MailValidationError } from '../../core/errors.mjs';

// Local allocation/wire ceilings, not a promise that provider-generated MIME fits.
const maxWireBytes = 30_000_000;
const encoder = new TextEncoder();

function preflight(message) {
  if (!message || typeof message !== 'object') fail('invalid_message');
  let recipients = 0;
  for (const field of ['to', 'cc', 'bcc']) {
    if (Array.isArray(message[field])) recipients += message[field].length;
  }
  if (recipients > 1000) fail('sendgrid_too_many_recipients');
  let bytes = 0;
  for (const field of ['text', 'html']) {
    const value = message[field];
    if (typeof value === 'string') {
      if (value.length >= maxWireBytes) fail('sendgrid_message_too_large');
      bytes += encoder.encode(value).byteLength;
    }
  }
  if (Array.isArray(message.attachments)) {
    if (message.attachments.length > 1000) fail('sendgrid_too_many_attachments');
    for (const attachment of message.attachments) {
      if (attachment?.content instanceof Uint8Array) bytes += 4 * Math.ceil(attachment.content.byteLength / 3);
      if (bytes >= maxWireBytes) fail('sendgrid_message_too_large');
    }
  }
  if (bytes >= maxWireBytes) fail('sendgrid_message_too_large');
  // Bound records before the shared validator serializes custom arguments.
  for (const field of ['headers', 'customArgs']) {
    const record = message[field];
    if (record && typeof record === 'object') {
      const keys = Reflect.ownKeys(record);
      if (keys.length > (field === 'customArgs' ? 10_000 : 1000)) fail('sendgrid_metadata_too_large');
      let size = 0;
      for (const key of keys) {
        const value = record[key];
        size += typeof key === 'string' ? key.length : 0;
        size += typeof value === 'string' ? value.length : 0;
        if (size > (field === 'customArgs' ? 10_000 : 1_000_000)) fail('sendgrid_metadata_too_large');
      }
    }
  }
}

/** Validated deterministic request bytes, without any provider or outbox effect. */
export function serializeSendGridMessage(message) {
  try {
    preflight(message);
    validateMessage(message, 'sendgrid');
    // Only the real unsubscribe assembler consumes this feature request.
    if (message.unsubscribe !== undefined) fail('unsubscribe_requires_facade');
    if (!message.subject.length) fail('sendgrid_subject_required');
    const from = parseAddress(message.from);
    if (/[^\x00-\x7f]/.test(from.email)) fail('sendgrid_ascii_sender_required');
    const personalization = { to: message.to.map(parseAddress) };
    if (message.cc?.length) personalization.cc = message.cc.map(parseAddress);
    if (message.bcc?.length) personalization.bcc = message.bcc.map(parseAddress);
    const recipients = new Set();
    for (const list of Object.values(personalization)) {
      for (const { email } of list) {
        const key = email.toLowerCase();
        if (recipients.has(key)) fail('sendgrid_duplicate_recipient');
        recipients.add(key);
      }
    }
    const content = [];
    for (const [field, type] of [['text', 'text/plain'], ['html', 'text/html']]) {
      if (message[field] !== undefined) {
        if (!message[field].length) fail('sendgrid_empty_content');
        content.push({ type, value: message[field] });
      }
    }
    const attachments = message.attachments?.map(attachment => {
      if (!attachment.content.byteLength) fail('sendgrid_empty_attachment');
      return {
        content: encodeBase64(attachment.content), type: attachment.contentType,
        filename: attachment.filename, disposition: attachment.disposition ?? 'attachment',
        ...(attachment.contentId === undefined ? {} : { content_id: attachment.contentId }),
      };
    });
    const body = JSON.stringify({
      personalizations: [personalization], from, subject: message.subject, content,
      ...(message.replyTo === undefined ? {} : { reply_to: parseAddress(message.replyTo) }),
      // The facade always supplies a headers object; an empty one is the same request as none.
      ...(message.headers === undefined || !Reflect.ownKeys(message.headers).length ? {} : { headers: message.headers }),
      ...(attachments?.length ? { attachments } : {}),
      custom_args: { ...message.customArgs, rer_delivery_id: message.deliveryId },
      ...(message.asmGroupId === undefined ? {} : { asm: { group_id: message.asmGroupId } }),
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false },
        ganalytics: { enable: false },
        ...(message.subscriptionTracking === undefined ? {} : { subscription_tracking: { enable: message.subscriptionTracking } }),
      },
    });
    if (encoder.encode(body).byteLength >= maxWireBytes) fail('sendgrid_message_too_large');
    return body;
  } catch (error) {
    if (error instanceof MailValidationError) throw error;
    fail('invalid_mail_input');
  }
}
