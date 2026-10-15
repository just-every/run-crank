import { createMailSender } from '../sender.mjs';
import { fail } from '../core/errors.mjs';
import { parseAddress, validateConfig, validateSendResult } from '../core/validation.mjs';
import { bounded, credential, digest, integer, object } from './common.mjs';
import { receiveProbe } from './receive.mjs';

export function validateProbe(options) {
  object(options.send, ['config', 'from', 'to'], 'doctor_send_config_required');
  validateConfig(options.send.config);
  if (options.send.config.provider !== options.provider || options.send.config.mode !== 'production') fail('doctor_remote_production_required');
  const from = parseAddress(options.send.from).email;
  if (from.split('@')[1].toLowerCase() !== options.domain) fail('doctor_sender_domain_mismatch');
  const to = parseAddress(options.send.to).email;
  object(options.receive, ['provider', 'apiKey'], 'doctor_receive_config_required');
  if (options.receive.provider !== 'resend') fail('doctor_receive_provider_unsupported');
  credential(options.receive.apiKey);
  return {
    from, to,
    timeoutMs: integer(options.timeoutMs ?? 60000, 100, 120000, 'invalid_doctor_timeout'),
    pollIntervalMs: integer(options.pollIntervalMs ?? 2000, 100, 10000, 'invalid_doctor_poll_interval'),
  };
}

export async function runProbe(options, dependencies) {
  const config = validateProbe(options);
  let sender;
  try {
    sender = dependencies.sender ?? createMailSender(options.send.config, { fetch: dependencies.fetch });
    if (!sender || typeof sender.send !== 'function') fail('doctor_sender_unavailable');
  } catch {
    return [
      { id: 'send', status: 'fail', nextSteps: ['Check sender configuration and install the complete mail module before retrying.'], evidence: { state: 'configuration_error' } },
      { id: 'receive', status: 'not_checked', nextSteps: ['Complete sender configuration before testing receipt.'], evidence: { state: 'unchecked' } },
    ];
  }
  const correlationId = crypto.randomUUID();
  const probe = {
    deliveryId: correlationId, from: config.from, to: [config.to],
    subject: `Mail doctor ${correlationId}`,
    text: `Mail doctor receive correlation: ${correlationId}`,
  };
  const startedAt = Date.now();
  let result;
  try {
    result = validateSendResult(await bounded(() => sender.send(probe), 16000), options.provider);
  } catch {
    result = { provider: options.provider, status: 'uncertain', providerMessageId: null };
  }
  const accepted = result.status === 'accepted' && (!result.recipientResults ||
    result.recipientResults.some(row => parseAddress(row.recipient).email.toLowerCase() === config.to.toLowerCase() && row.status === 'accepted'));
  const send = {
    id: 'send', status: accepted ? 'pass' : result.status === 'uncertain' ? 'pending' : 'fail',
    nextSteps: [accepted ? 'The provider accepted the submission. Inspect independent mailbox receipt below.' :
      result.status === 'uncertain' ? 'Submission is uncertain. Reconcile provider and mailbox records before any resend.' :
      'The provider did not accept the test recipient. Check sender verification, credentials, limits and suppression; no retry was attempted.'],
    evidence: {
      state: result.status, recipientAccepted: accepted, correlationId,
      providerMessageIdSha256: result.providerMessageId ? await digest(result.providerMessageId) : null,
      startedAt: new Date(startedAt).toISOString(),
    },
  };
  const receive = accepted || result.status === 'uncertain'
    ? await receiveProbe({ apiKey: options.receive.apiKey, probe, startedAt, timeoutMs: config.timeoutMs, pollIntervalMs: config.pollIntervalMs }, dependencies)
    : { id: 'receive', status: 'not_checked', nextSteps: ['Resolve the rejected submission before initiating another test.'], evidence: { state: 'unchecked' } };
  return [send, receive];
}
