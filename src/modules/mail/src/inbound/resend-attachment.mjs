import { fail, MailValidationError } from '../core/errors.mjs';
import { validateConfig } from '../core/validation.mjs';
import { decode, readStream } from './bytes.mjs';
import { attachmentMetadata } from './resend.mjs';
/** Call only after authenticating email.received and binding the hydrated email ID. */
export function createResendAttachmentFetcher({ apiKey, maxAttachmentBytes }, dependencies = {}) {
  validateConfig({ provider: 'resend', mode: 'production', apiKey }, dependencies);
  if (!Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes <= 0) fail('invalid_inbound_limits');
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const clock = dependencies.clock ?? Date.now;
  return async expected => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const item = attachmentMetadata(expected, expected.emailId);
      if (item.size > maxAttachmentBytes) fail('inbound_attachment_limit');
      // Fixed API origin, escaped identifiers, and manual redirects prevent credential forwarding.
      const response = await fetcher(`https://api.resend.com/emails/receiving/${encodeURIComponent(item.emailId)}/attachments/${encodeURIComponent(item.id)}`, {
        method: 'GET', headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, redirect: 'manual', signal: controller.signal,
      });
      if (response.status !== 200) fail('inbound_attachment_fetch_failed');
      const data = JSON.parse(decode(await readStream(response.body, 65_536)));
      const actual = attachmentMetadata(data, item.emailId);
      for (const key of ['id', 'filename', 'content_type', 'content_disposition', 'content_id', 'size']) {
        if (actual[key] !== item[key]) fail('inbound_attachment_metadata_mismatch');
      }
      const url = new URL(data.download_url);
      // The documented provider CDN is the only accepted download origin.
      if (url.origin !== 'https://inbound-cdn.resend.com' || url.username || url.password || url.hash ||
          url.pathname !== `/${item.emailId}/attachments/${item.id}` || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= clock()) fail('unsafe_inbound_attachment_url');
      const download = await fetcher(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal });
      if (download.status !== 200) fail('inbound_attachment_fetch_failed');
      const length = download.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== item.size)) fail('inbound_attachment_size_mismatch');
      const bytes = await readStream(download.body, Math.min(item.size, maxAttachmentBytes));
      if (bytes.length !== item.size) fail('inbound_attachment_size_mismatch');
      return bytes;
    } catch (error) {
      if (error instanceof MailValidationError) throw error;
      fail('inbound_attachment_fetch_failed');
    } finally { clearTimeout(timer); }
  };
}
