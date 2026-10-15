import { fail } from '../../core/errors.mjs';
import { validateMessage, encodeBase64 } from '../../core/validation.mjs';

const encoder = new TextEncoder();
export function serializeMessagingMessage(message) {
  validateMessage(message, 'messaging');
  if (message.unsubscribe !== undefined) fail('unconsumed_unsubscribe');
  if (encoder.encode(message.text ?? '').length + encoder.encode(message.html ?? '').length > 1024 * 1024) fail('messaging_body_too_large');
  let attachmentBytes = 0;
  for (const attachment of message.attachments ?? []) attachmentBytes += attachment.content.byteLength;
  if (attachmentBytes > 5 * 1024 * 1024) fail('messaging_attachments_too_large');
  for (const name of Object.keys(message.headers ?? {})) {
    if (!/^(?:list-[a-z0-9-]+|x-[a-z0-9-]+|auto-submitted|in-reply-to|references|message-id)$/i.test(name)) fail('unsupported_messaging_header');
  }
  const { to, attachments, ...rest } = message;
  const body = encoder.encode(JSON.stringify({ ...rest, to: to[0], ...(attachments === undefined ? {} : {
    attachments: attachments.map(attachment => ({ ...attachment, content: encodeBase64(attachment.content) })),
  }) }));
  if (body.length > 8 * 1024 * 1024) fail('messaging_request_too_large');
  return body;
}
