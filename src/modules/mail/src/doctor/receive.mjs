import { fail } from '../core/errors.mjs';
import { parseAddress } from '../core/validation.mjs';
import { bounded, digest, readJson } from './common.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function mailbox(value) {
  try { return parseAddress(value).email.toLowerCase(); } catch { return null; }
}
function candidate(email, probe, startedAt, now) {
  const received = Date.parse(email?.created_at);
  return email && uuid.test(email.id) && email.subject === probe.subject &&
    mailbox(email.from) === mailbox(probe.from) && Array.isArray(email.to) && email.to.some(value => mailbox(value) === mailbox(probe.to[0])) &&
    Number.isFinite(received) && received >= startedAt - 1000 && received <= now + 1000;
}

/** Read received mail only; never read sent-message status as delivery proof. */
export async function receiveProbe({ apiKey, probe, startedAt, timeoutMs, pollIntervalMs }, dependencies = {}) {
  const deadline = Date.now() + timeoutMs;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  let polls = 0, requests = 0;
  async function get(path) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('doctor_receive_timeout');
    requests++;
    return bounded(async signal => {
      const response = await fetcher(`https://api.resend.com${path}`, {
        method: 'GET', redirect: 'manual', signal, headers: { authorization: `Bearer ${apiKey}` },
      });
      if (response.status !== 200) fail('doctor_readback_failed');
      return readJson(response);
    }, Math.min(8000, remaining));
  }
  try {
    while (Date.now() < deadline && polls < 30) {
      polls++;
      let after = '';
      for (let page = 0; page < 3; page++) {
        const list = await get(`/emails/receiving?limit=100${after ? `&after=${after}` : ''}`);
        if (!list || list.object !== 'list' || !Array.isArray(list.data) || list.data.length > 100 || typeof list.has_more !== 'boolean') fail('doctor_readback_failed');
        for (const summary of list.data) {
          if (!candidate(summary, probe, startedAt, Date.now())) continue;
          const email = await get(`/emails/receiving/${summary.id}`);
          if (email?.id !== summary.id || email.object !== 'email' || !candidate(email, probe, startedAt, Date.now()) ||
              typeof email.text !== 'string' || email.text.trimEnd() !== probe.text ||
              typeof email.message_id !== 'string' || !/^<[^\s<>]{1,990}>$/.test(email.message_id)) fail('doctor_readback_conflict');
          return {
            id: 'receive', status: 'pass', nextSteps: ['Retain this independent received-mail receipt with the exact source SHA and protected workflow run.'],
            evidence: {
              state: 'received', source: 'resend_received_email_api', inboxMessageId: email.id,
              rfcMessageIdSha256: await digest(email.message_id), receivedAt: new Date(Date.parse(email.created_at)).toISOString(),
              correlationId: probe.deliveryId, bodySha256: await digest(probe.text),
              recipientSha256: await digest(mailbox(probe.to[0])), polls, requests,
            },
          };
        }
        if (!list.has_more) break;
        const cursor = list.data.at(-1)?.id;
        if (!uuid.test(cursor ?? '') || cursor === after) fail('doctor_readback_failed');
        after = cursor;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0 && polls < 30) {
        const nextPollAt = Math.min(deadline, Date.now() + pollIntervalMs);
        // A timer can wake before the wall-clock boundary due to rounding.
        // Recheck the intended wake time before spending another provider read.
        while (Date.now() < nextPollAt) {
          await new Promise(resolve => setTimeout(resolve, Math.max(1, nextPollAt - Date.now())));
        }
      }
    }
  } catch {
    if (Date.now() < deadline) return {
      id: 'receive', status: 'fail', nextSteps: ['Mailbox readback failed or returned conflicting data. Check receiving permissions and the retained provider message; no resend was attempted.'],
      evidence: { state: 'error', polls, requests, correlationId: probe.deliveryId },
    };
  }
  return {
    id: 'receive', status: 'pending', nextSteps: ['No matching received message appeared within the bounded mailbox scan. Inspect routing, spam and provider records before considering another send.'],
    evidence: { state: 'timeout', polls, requests, correlationId: probe.deliveryId, maxPagesPerPoll: 3, maxMessagesPerPage: 100 },
  };
}
