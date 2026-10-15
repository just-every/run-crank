import { fail, MailValidationError } from '../core/errors.mjs';
import { bounded, limitsFor, readStream, record } from './bytes.mjs';
import { parseMime } from './mime.mjs';
import { normalizeResend } from './resend.mjs';
import { normalizeSendGrid } from './sendgrid.mjs';
/** Trusted transport parser. Verify webhook bytes BEFORE calling or hydrating. */
export async function normalizeInbound(input, limits) {
  try {
    record(input); limits = limitsFor(limits); let result;
    switch (input.provider) {
      case 'cloudflare': {
        const message = input.message;
        if (!message || !(message.headers instanceof Headers) || !Number.isSafeInteger(message.rawSize) || message.rawSize < 0) fail('invalid_inbound_message');
        bounded(message.rawSize, limits.maxRawBytes, 'inbound_raw_limit');
        const raw = await readStream(message.raw, limits.maxRawBytes);
        if (raw.length !== message.rawSize) fail('inbound_raw_size_mismatch');
        result = parseMime(raw, limits, { from: message.from, to: message.to }); break;
      }
      case 'sendgrid': result = normalizeSendGrid(input, limits); break;
      case 'resend': result = await normalizeResend(input, limits); break;
      default: fail('invalid_inbound_provider');
    }
    return { provider: input.provider, ...result };
  } catch (error) {
    if (error instanceof MailValidationError) throw error;
    fail('invalid_inbound');
  }
}
export { createResendAttachmentFetcher } from './resend-attachment.mjs';
