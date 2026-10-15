import { fail } from '../core/errors.mjs';
import { bodyBudget, bounded, decode, transfer, utf8 } from './bytes.mjs';
import { contentId, contentType, headerText, metadata, parameter, parameterized } from './headers.mjs';
import { entity, multipart } from './multipart.mjs';
export function parseMime(bytes, limits, envelope) {
  const root = entity(bytes); const budget = bodyBudget(limits);
  const text = [], html = [], attachments = [];
  function visit(part, depth = 0) {
    if (depth > 30) fail('inbound_mime_depth');
    const type = parameterized(part.headers.get('content-type') ?? 'text/plain');
    contentType(type.type);
    const disposition = parameterized(part.headers.get('content-disposition') ?? 'inline');
    if (!['inline', 'attachment'].includes(disposition.type)) fail('invalid_inbound_disposition');
    const filename = parameter(disposition.params, 'filename') ?? parameter(type.params, 'name');
    const isAttachment = disposition.type === 'attachment' || filename !== null;
    const encoding = part.headers.get('content-transfer-encoding');
    if (type.type.startsWith('multipart/') && !isAttachment) {
      if (encoding && !['7bit', '8bit', 'binary'].includes(encoding.toLowerCase())) fail('invalid_inbound_encoding');
      for (const child of multipart(part.body, type.params.get('boundary'))) visit(entity(child), depth + 1);
      return;
    }
    const decoded = transfer(part.body, encoding ?? '8bit');
    if (!isAttachment && ['text/plain', 'text/html'].includes(type.type)) {
      const value = decode(decoded, type.params.get('charset') ?? 'utf-8');
      budget.body(value, decoded.length);
      (type.type === 'text/plain' ? text : html).push(value);
    } else {
      budget.attachment(decoded);
      attachments.push({ filename: headerText(filename ?? ''), contentType: type.type, content: decoded.slice(), contentId: contentId(part.headers.get('content-id')) });
    }
  }
  visit(root);
  const plain = text.length ? text.join('\n') : null, rich = html.length ? html.join('\n') : null;
  bounded(utf8.encode(plain ?? '').length + utf8.encode(rich ?? '').length, limits.maxBodyBytes, 'inbound_body_limit');
  return { ...metadata(root.headers, envelope?.from ?? root.headers.get('from'), envelope?.to ?? root.headers.get('to')), text: plain, html: rich, attachments };
}
