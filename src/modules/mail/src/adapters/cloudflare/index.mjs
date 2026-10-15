import { fail } from '../../core/errors.mjs';
import { encodeBase64, parseAddress, validateConfig, validateMessage } from '../../core/validation.mjs';
import { classifyHttpStatus, requestProvider, sendResult } from '../../core/transport.mjs';
import { validateCloudflareHeaders } from './headers.mjs';
import { cloudflareResult, readCloudflareResponse } from './response.mjs';

function address(value) {
  const { email, name } = parseAddress(value);
  return name === undefined ? email : { address: email, name };
}

/** Cloudflare Email Sending REST API, independent of Email Routing send bindings. */
export async function sendCloudflare(config, message, dependencies = {}) {
  validateConfig(config, dependencies);
  if (config.provider !== 'cloudflare') fail('cloudflare_provider_required');
  if (message && Object.hasOwn(message, 'unsubscribe')) fail('unsubscribe_requires_facade');
  validateMessage(message, 'cloudflare');
  validateCloudflareHeaders(message.headers);
  const body = { from: address(message.from), to: message.to.map(address), subject: message.subject };
  for (const field of ['text', 'html', 'headers']) if (message[field] !== undefined) body[field] = message[field];
  for (const field of ['cc', 'bcc']) if (message[field] !== undefined) body[field] = message[field].map(address);
  if (message.replyTo !== undefined) body.reply_to = address(message.replyTo);
  if (message.attachments !== undefined) body.attachments = message.attachments.map(attachment => {
    // The structured REST schema permits content_id only on inline attachments.
    if (attachment.contentId !== undefined && attachment.disposition !== 'inline') fail('cloudflare_unsupported_attachment_content_id');
    return {
      filename: attachment.filename, type: attachment.contentType,
      content: encodeBase64(attachment.content), disposition: attachment.disposition ?? 'attachment',
      ...(attachment.contentId === undefined ? {} : { content_id: attachment.contentId }),
    };
  });
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > 5 * 1024 * 1024) fail('cloudflare_message_too_large');
  const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map(value => parseAddress(value).email);
  const response = await requestProvider(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`,
    { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: serialized },
    dependencies,
  );
  if (response === null) return sendResult('cloudflare', 'uncertain', null, 'cloudflare_transport_failed');
  const status = classifyHttpStatus(response.status);
  if (status !== null) {
    void response.body?.cancel().catch(() => {});
    return sendResult('cloudflare', status, null, 'cloudflare_http_error');
  }
  return cloudflareResult(await readCloudflareResponse(response), recipients);
}
