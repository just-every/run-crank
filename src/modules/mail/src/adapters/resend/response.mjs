import { classifyHttpStatus, safeProviderMessageId, sendResult } from '../../core/transport.mjs';

// Only bounded structured responses are inspected. Body text never becomes diagnostics.
async function readObject(response) {
  let reader;
  let timer;
  try {
    reader = response.body?.getReader();
    if (!reader) return null;
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve(null), 15_000); });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (!chunk) return null;
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65_536) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const data = JSON.parse(text + decoder.decode());
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
  finally {
    clearTimeout(timer);
    // Cancellation itself can fail or stall on a broken stream; never wait for it.
    if (reader) void reader.cancel().catch(() => {});
  }
}

export async function resendResult(response) {
  if (!response) return sendResult('resend', 'uncertain', null, 'transport_error');
  if (response.status === 409) {
    const data = await readObject(response);
    if (data?.name === 'invalid_idempotent_request') return sendResult('resend', 'rejected', null, 'idempotency_conflict');
    if (data?.name === 'concurrent_idempotent_requests') return sendResult('resend', 'uncertain', null, 'idempotency_in_progress');
    return sendResult('resend', 'uncertain', null, 'idempotency_unknown_conflict');
  }
  const status = classifyHttpStatus(response.status);
  if (status) {
    if (response.body) void response.body.cancel().catch(() => {});
    return sendResult('resend', status, null, status === 'rate_limited' ? 'rate_limited' : status === 'rejected' ? 'provider_rejected' : 'unexpected_response');
  }
  // POST /emails documents HTTP 200 with an id, not bare HTTP success.
  if (response.status !== 200) {
    if (response.body) void response.body.cancel().catch(() => {});
    return sendResult('resend', 'uncertain', null, 'unexpected_response');
  }
  const data = await readObject(response);
  const id = safeProviderMessageId(data?.id);
  if (!id || id !== data.id || 'error' in data || 'name' in data) return sendResult('resend', 'uncertain', null, 'invalid_provider_response');
  return sendResult('resend', 'accepted', id);
}
