import { fail } from '../core/errors.mjs';
import { bodyBudget, bounded, decode, record, transfer } from './bytes.mjs';
import { contentId, contentType, headerText, metadata, parameter, parameterized, parseHeaders } from './headers.mjs';
import { entity, multipart } from './multipart.mjs';
import { parseMime } from './mime.mjs';
function json(value) {
  try { return record(JSON.parse(value)); } catch { fail('invalid_inbound_json'); }
}
export function normalizeSendGrid(input, limits) {
  if (!(input.rawBody instanceof Uint8Array)) fail('invalid_inbound_raw');
  bounded(input.rawBody.length, limits.maxRawBytes, 'inbound_raw_limit');
  const formType = parameterized(input.contentType);
  if (formType.type !== 'multipart/form-data') fail('invalid_inbound_content_type');
  const fields = new Map(), files = new Map();
  for (const raw of multipart(input.rawBody, formType.params.get('boundary'))) {
    const part = entity(raw); const disposition = parameterized(part.headers.get('content-disposition') ?? '');
    const name = disposition.params.get('name');
    if (disposition.type !== 'form-data' || !name || fields.has(name) || files.has(name)) fail('invalid_inbound_form');
    const filename = parameter(disposition.params, 'filename');
    const bytes = transfer(part.body, part.headers.get('content-transfer-encoding') ?? 'binary');
    if (filename !== null) {
      if (!/^attachment\d+$/.test(name)) fail('invalid_inbound_form');
      const type = parameterized(part.headers.get('content-type') ?? 'application/octet-stream');
      files.set(name, { filename, contentType: contentType(type.type), content: bytes.slice(), contentId: contentId(part.headers.get('content-id')) });
    } else fields.set(name, { bytes, type: parameterized(part.headers.get('content-type') ?? 'text/plain') });
  }
  const charsets = fields.has('charsets') ? json(decode(fields.get('charsets').bytes)) : {};
  for (const value of Object.values(charsets)) if (typeof value !== 'string') fail('invalid_inbound_charset');
  const field = name => fields.has(name) ? decode(fields.get(name).bytes, fields.get(name).type.params.get('charset') ?? charsets[name] ?? 'utf-8') : undefined;
  if (fields.has('email')) {
    if (files.size || fields.has('text') || fields.has('html')) fail('ambiguous_inbound_mime');
    return parseMime(fields.get('email').bytes, limits);
  }
  const headers = parseHeaders(field('headers') ?? '');
  const result = metadata(headers, field('from') ?? headers.get('from'), field('to') ?? headers.get('to'), field('subject'));
  const text = field('text') ?? null, html = field('html') ?? null;
  if (text === null && html === null && files.size === 0) fail('invalid_inbound_body');
  const count = field('attachments') ?? '0';
  if (!/^(?:0|[1-9]\d*)$/.test(count) || Number(count) !== files.size) fail('invalid_inbound_attachment_count');
  const info = fields.has('attachment-info') ? json(field('attachment-info')) : {};
  const ids = fields.has('content-ids') ? json(field('content-ids')) : {};
  for (const name of Object.keys(info)) if (!files.has(name)) fail('invalid_inbound_attachment_metadata');
  const reverseIds = new Map();
  for (const [id, name] of Object.entries(ids)) {
    if (typeof name !== 'string' || !files.has(name) || reverseIds.has(name)) fail('invalid_inbound_attachment_metadata');
    reverseIds.set(name, contentId(id));
  }
  const budget = bodyBudget(limits); const attachments = [];
  if (text !== null) budget.body(text, fields.get('text').bytes.length);
  if (html !== null) budget.body(html, fields.get('html').bytes.length);
  for (const [name, file] of files) {
    const details = info[name] === undefined ? {} : record(info[name]);
    if (details.filename !== undefined && headerText(details.filename) !== file.filename) fail('inbound_attachment_metadata_mismatch');
    if (details.type !== undefined && contentType(details.type) !== file.contentType) fail('inbound_attachment_metadata_mismatch');
    const identifiers = [file.contentId, contentId(details['content-id']), reverseIds.get(name)].filter(id => id != null);
    if (new Set(identifiers).size > 1) fail('inbound_attachment_metadata_mismatch');
    budget.attachment(file.content); attachments.push({ ...file, contentId: identifiers[0] ?? null });
  }
  return { ...result, text, html, attachments };
}
