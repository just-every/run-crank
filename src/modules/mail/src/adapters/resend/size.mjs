import { fail } from '../../core/errors.mjs';

// Resend documents 40 MB including Base64 attachments. Use decimal MB and leave
// 1 MB for provider-added MIME/envelope/signature data; see the adapter README.
export const MAX_RESEND_EMAIL_BYTES = 40_000_000;
export const MAX_RESEND_REQUEST_BYTES = 39_000_000;
const ENVELOPE_RESERVE = MAX_RESEND_EMAIL_BYTES - MAX_RESEND_REQUEST_BYTES;
const PART_RESERVE = 2048;
const tooLarge = () => fail('resend_message_too_large');
const base64Size = bytes => 4 * Math.ceil(bytes / 3);
const foldedBase64Size = bytes => {
  const encoded = base64Size(bytes);
  return encoded + 2 * Math.ceil(encoded / 76);
};

// Count without TextEncoder/JSON copies, including JSON escapes and lone UTF-16
// surrogates. Stop once even the source string exceeds the remaining budget.
function stringSize(value, limit) {
  if (value.length > limit) tooLarge();
  let utf8 = 0;
  let json = 2; // quotes
  let quotedPrintable = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    let bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    let unpaired = code >= 0xd800 && code <= 0xdfff;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes = 4; unpaired = false; i++; }
    }
    utf8 += bytes;
    json += unpaired || code < 0x20 && ![8, 9, 10, 12, 13].includes(code) ? 6
      : code === 34 || code === 92 || code < 0x20 ? 2 : bytes;
    // Encode all whitespace conservatively, including trailing spaces/tabs.
    quotedPrintable += code >= 33 && code <= 126 && code !== 61 ? 1
      : code === 10 || code === 13 ? 2 : 3 * bytes;
    if (json > limit) tooLarge();
  }
  return { utf8, json, quotedPrintable };
}

/** Preflight validated inputs before mailbox arrays, Base64 or JSON allocation. */
export function assertResendMessageSize(message) {
  let request = 1024; // fixed JSON field names, delimiters and optional containers
  let email = ENVELOPE_RESERVE;
  function add(requestBytes, emailBytes) {
    request += requestBytes;
    email += emailBytes;
    if (request > MAX_RESEND_REQUEST_BYTES || email > MAX_RESEND_EMAIL_BYTES) tooLarge();
  }
  function metadata(value) {
    const size = stringSize(value, MAX_RESEND_REQUEST_BYTES - request);
    // Covers MIME header encoding/folding plus address quoting/normalization.
    add(size.json + 64, 6 * size.utf8 + 128);
  }
  metadata(message.from);
  metadata(message.subject);
  if (message.replyTo !== undefined) metadata(message.replyTo);
  for (const field of ['to', 'cc', 'bcc']) {
    for (const value of message[field] ?? []) metadata(value);
  }
  for (const name in message.headers) {
    if (!Object.hasOwn(message.headers, name)) continue;
    metadata(name);
    metadata(message.headers[name]);
  }
  for (const field of ['text', 'html']) {
    if (message[field] === undefined) continue;
    const size = stringSize(message[field], MAX_RESEND_REQUEST_BYTES - request);
    // Reserve the larger of Base64 and conservative quoted-printable transfer
    // encodings, including line folding, without assuming Resend's MIME choice.
    const quotedPrintable = size.quotedPrintable + 3 * Math.ceil(size.quotedPrintable / 73);
    const part = PART_RESERVE + Math.max(foldedBase64Size(size.utf8), quotedPrintable);
    // HTML-only requests permit provider-generated plain text. Budget another
    // part; explicit text (including an empty string) suppresses that generation.
    add(size.json, part * (field === 'html' && message.text === undefined ? 2 : 1));
  }
  for (const attachment of message.attachments ?? []) {
    // Charge the complete aggregate before any attachment bytes are read.
    add(base64Size(attachment.content.byteLength) + 128,
      PART_RESERVE + foldedBase64Size(attachment.content.byteLength));
    metadata(attachment.filename);
    metadata(attachment.contentType);
    if (attachment.contentId !== undefined) metadata(attachment.contentId);
  }
}

/** Final actual UTF-8 request bound, independently of the preflight estimate. */
export function assertResendRequestSize(body) {
  // A valid JSON string has no unescaped lone surrogates. Counting code points
  // avoids allocating a second body-sized Uint8Array just to measure the request.
  if (body.length > MAX_RESEND_REQUEST_BYTES) tooLarge();
  let bytes = 0;
  for (const character of body) {
    const code = character.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > MAX_RESEND_REQUEST_BYTES) tooLarge();
  }
}
