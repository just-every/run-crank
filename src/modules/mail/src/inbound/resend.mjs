import { fail } from '../core/errors.mjs';
import { bodyBudget, bounded, record, utf8 } from './bytes.mjs';
import { contentId, contentType, headerText, metadata, objectHeaders } from './headers.mjs';
export function providerId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) fail('invalid_inbound_provider_id');
  return value;
}
export function attachmentMetadata(value, emailId) {
  record(value); providerId(emailId);
  const id = providerId(value.id);
  if (!Number.isSafeInteger(value.size) || value.size < 0) fail('invalid_inbound_attachment_size');
  if (value.content_disposition != null && !['inline', 'attachment'].includes(value.content_disposition)) fail('invalid_inbound_disposition');
  return Object.freeze({ emailId, id, filename: headerText(value.filename), content_type: contentType(value.content_type),
    content_disposition: value.content_disposition ?? null, content_id: contentId(value.content_id), size: value.size });
}
export async function normalizeResend(input, limits) {
  const email = record(input.email);
  const id = providerId(email.id);
  if (id !== providerId(input.signedEmailId)) fail('inbound_identity_mismatch');
  // Hydrated API JSON is the available raw representation, not the SMTP original.
  let raw; try { raw = JSON.stringify(email); } catch { fail('invalid_inbound_raw'); }
  bounded(utf8.encode(raw).length, limits.maxRawBytes, 'inbound_raw_limit');
  const headers = objectHeaders(email.headers);
  if (email.message_id != null) {
    if (headers.has('message-id') && headers.get('message-id') !== email.message_id) fail('inbound_identity_mismatch');
    headers.set('message-id', email.message_id);
  }
  const result = metadata(headers, email.from, email.to, email.subject);
  const text = email.text ?? null, html = email.html ?? null;
  if ((text !== null && typeof text !== 'string') || (html !== null && typeof html !== 'string')) fail('invalid_inbound_body');
  const budget = bodyBudget(limits);
  if (text !== null) budget.body(text);
  if (html !== null) budget.body(html);
  if (!Array.isArray(email.attachments)) fail('invalid_inbound_attachments');
  bounded(email.attachments.length, limits.maxAttachments, 'inbound_attachment_count');
  const declared = email.attachments.map(item => attachmentMetadata(item, id));
  if (new Set(declared.map(item => item.id)).size !== declared.length) fail('duplicate_inbound_attachment');
  let total = 0;
  for (const item of declared) {
    bounded(item.size, limits.maxAttachmentBytes, 'inbound_attachment_limit'); total += item.size;
    bounded(total, limits.maxTotalAttachmentBytes, 'inbound_attachments_limit');
  }
  if (text === null && html === null && !declared.length) fail('invalid_inbound_body');
  if (declared.length && typeof input.fetchAttachment !== 'function') fail('inbound_attachment_fetch_required');
  const attachments = [];
  for (const item of declared) {
    // Only verified identifiers and sanitized metadata cross this seam; never URLs.
    const content = await input.fetchAttachment(item);
    budget.attachment(content);
    if (content.length !== item.size) fail('inbound_attachment_size_mismatch');
    attachments.push({ filename: item.filename, contentType: item.content_type, content: content.slice(), contentId: item.content_id });
  }
  return { ...result, text, html, attachments };
}
