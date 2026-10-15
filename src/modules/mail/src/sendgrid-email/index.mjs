import { MailValidationError } from '../core/errors.mjs';
import { sendSendGrid as submit, serializeSendGridMessage as serialize } from '../adapters/sendgrid/index.mjs';

// The API of the former `modules/sendgrid-email` module, kept for existing adopters.
// It owns no transport: every request is built and sent by the one SendGrid adapter
// in this module, so both import paths put identical requests on the wire.

export class SendGridSendError extends Error {
  constructor(outcome, message, status) {
    super(message);
    this.name = 'SendGridSendError';
    this.outcome = outcome;
    this.status = status;
  }
}

function rejected(message) { return new SendGridSendError('rejected', message); }

// Diagnostics carry only the fixed validation code, never input values.
function invalid(error) {
  if (error instanceof MailValidationError) return rejected(`SendGrid message or key is invalid (${error.code}).`);
  return rejected('SendGrid message or key is invalid.');
}

function decodeAttachment(attachment) {
  const content = attachment?.content;
  if (typeof content !== 'string' || !content || !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(content)) throw rejected('Attachment content must be base64.');
  let binary;
  try { binary = atob(content); } catch { throw rejected('Attachment content must be base64.'); }
  return {
    filename: attachment.filename,
    contentType: attachment.type ?? 'application/octet-stream',
    content: Uint8Array.from(binary, character => character.charCodeAt(0)),
  };
}

// Only the former module's fields are read, so unknown fields stay ignored as before.
function toMailMessage(message) {
  if (!message || typeof message !== 'object') throw rejected('SendGrid message is required.');
  const mapped = { deliveryId: message.deliveryId, from: message.from, to: message.to, subject: message.subject, text: message.text };
  if (message.html) mapped.html = message.html;
  if (message.replyTo) mapped.replyTo = message.replyTo;
  for (const field of ['headers', 'customArgs', 'asmGroupId', 'subscriptionTracking']) {
    if (message[field] !== undefined) mapped[field] = message[field];
  }
  if (message.attachments?.length) mapped.attachments = message.attachments.map(decodeAttachment);
  return mapped;
}

/** Validated wire envelope, also usable as a durable claim fingerprint. */
export function serializeSendGridMessage(message) {
  try { return serialize(toMailMessage(message)); } catch (error) {
    throw error instanceof SendGridSendError ? error : invalid(error);
  }
}

/** One attempt only. Acceptance and a provider receipt are distinct evidence. */
export async function sendSendGrid(input) {
  if (typeof input?.apiKey !== 'string' || !input.apiKey.trim()) throw rejected('SendGrid API key is required.');
  const message = toMailMessage(input.message);
  const baseFetch = input.fetch ?? globalThis.fetch;
  let httpStatus;
  // The adapter result classifies the outcome; the exact HTTP status is kept for callers.
  const observedFetch = async (url, init) => {
    const response = await baseFetch(url, init);
    httpStatus = response?.status;
    return response;
  };
  const dependencies = { fetch: observedFetch };
  if (input.timeoutMilliseconds !== undefined) dependencies.timeoutMilliseconds = input.timeoutMilliseconds;
  let result;
  try {
    result = await submit({ provider: 'sendgrid', mode: 'production', apiKey: input.apiKey }, message, dependencies);
  } catch (error) { throw invalid(error); }
  switch (result.status) {
    case 'accepted':
      return { provider: 'sendgrid', providerMessageId: result.providerMessageId, state: 'accepted' };
    case 'rate_limited':
      throw new SendGridSendError('rate_limited', 'SendGrid rate limited this submission.', httpStatus);
    case 'rejected':
      throw new SendGridSendError('rejected', `SendGrid rejected this submission (${httpStatus}).`, httpStatus);
    default:
      if (httpStatus === undefined) throw new SendGridSendError('ambiguous', 'SendGrid submission did not return a receipt; reconcile before resending.');
      throw new SendGridSendError('ambiguous', `SendGrid returned an unconfirmed submission status (${httpStatus}); reconcile before resending.`, httpStatus);
  }
}
