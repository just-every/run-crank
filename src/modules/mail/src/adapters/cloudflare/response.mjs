import { safeProviderMessageId, sendResult } from '../../core/transport.mjs';
import { parseAddress } from '../../core/validation.mjs';

const provider = 'cloudflare';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The domain is case-insensitive; do not collapse distinct case-sensitive local parts.
export function mailboxKey(email) {
  const at = email.lastIndexOf('@');
  return email.slice(0, at + 1) + email.slice(at + 1).toLowerCase();
}

export function cloudflareResult(body, recipients) {
  const unknown = () => sendResult(provider, 'uncertain', null, 'cloudflare_invalid_response');
  if (!record(body) || typeof body.success !== 'boolean' || !Array.isArray(body.errors)) return unknown();
  if (body.success === false) {
    // A contradictory result may reflect a send that already took effect.
    if (body.result !== null && body.result !== undefined) return unknown();
    const codes = body.errors.map(error => error?.code);
    const status = codes.some(code => [10002, 10003, 10100].includes(code)) ? 'uncertain'
      : codes.includes(10004) ? 'rate_limited' : 'rejected';
    return sendResult(provider, status, null, 'cloudflare_provider_error');
  }
  if (body.errors.length || !record(body.result)) return unknown();
  const result = body.result;
  const id = safeProviderMessageId(result.message_id);
  if (result.message_id !== undefined && result.message_id !== null && id === null) return unknown();
  const groups = [
    ['delivered', 'accepted'], ['queued', 'accepted'],
    ['permanent_bounces', 'rejected'], ['suppressed_recipients', 'rejected'],
  ];
  const outcomes = new Map();
  const requested = new Map(recipients.map(recipient => [mailboxKey(recipient), recipient]));
  let malformed = false;
  for (const [field, status] of groups) {
    const list = result[field];
    if (field === 'suppressed_recipients' && list === undefined) continue;
    if (!Array.isArray(list)) { malformed = true; continue; }
    for (const value of list) {
      let email;
      try {
        const parsed = parseAddress(value);
        if (parsed.name || parsed.email !== value) { malformed = true; continue; }
        email = mailboxKey(parsed.email);
      } catch { malformed = true; continue; }
      if (!requested.has(email)) { malformed = true; continue; }
      if (outcomes.has(email)) {
        // Even repeated identical groups have ambiguous recipient cardinality.
        outcomes.set(email, 'uncertain');
        malformed = true;
      } else outcomes.set(email, status);
    }
  }
  const recipientResults = [...requested].map(([key, recipient]) => ({
    recipient, status: outcomes.get(key) ?? 'uncertain',
  }));
  if (malformed || recipientResults.some(item => item.status === 'uncertain')) {
    return sendResult(provider, 'uncertain', id, 'cloudflare_incomplete_recipient_results', recipientResults);
  }
  const accepted = recipientResults.filter(item => item.status === 'accepted').length;
  if (accepted === recipientResults.length) return sendResult(provider, 'accepted', id, undefined, recipientResults);
  if (accepted === 0) return sendResult(provider, 'rejected', id, 'cloudflare_recipients_rejected', recipientResults);
  // The common result union has no partial status. Never encourage retrying the batch.
  return sendResult(provider, 'uncertain', id, 'cloudflare_partial_recipient_failure', recipientResults);
}

export async function readCloudflareResponse(response) {
  // Bound both bytes and time after response headers; errors never expose the body.
  let reader;
  try { reader = response.body?.getReader(); } catch { return null; }
  if (!reader) return null;
  let timer;
  let finished = false;
  const read = async () => {
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (finished) return null;
      if (done) break;
      length += value.byteLength;
      if (length > 1024 * 1024) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  };
  try {
    return await Promise.race([
      read().catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 15_000); }),
    ]);
  } finally {
    finished = true;
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
