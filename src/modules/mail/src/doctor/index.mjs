import { fail } from '../core/errors.mjs';
import { hostname, object } from './common.mjs';
import { recordPlan, dnsPlan } from './records.mjs';
import { checkDns } from './dns.mjs';
import { runProbe, validateProbe } from './probe.mjs';

/** Portable structured setup diagnosis. No network operation without live:true. */
export async function mailDoctor(options, dependencies = {}) {
  object(options, ['domain', 'provider', 'dnsRecords', 'live', 'send', 'receive', 'timeoutMs', 'pollIntervalMs']);
  const domain = hostname(options.domain);
  if (!['sendgrid', 'resend', 'cloudflare'].includes(options.provider)) fail('invalid_doctor_provider');
  if (options.live !== undefined && typeof options.live !== 'boolean') fail('invalid_doctor_live');
  object(dependencies, ['fetch', 'resolveDns', 'sender'], 'invalid_doctor_dependencies');
  if (dependencies.fetch !== undefined && typeof dependencies.fetch !== 'function' || dependencies.resolveDns !== undefined && typeof dependencies.resolveDns !== 'function') fail('invalid_doctor_dependencies');
  const plan = recordPlan(options.dnsRecords);
  let items = dnsPlan(domain, options.provider, plan);
  if (options.live) {
    // Validate every credential/address before DNS or sending has any effect.
    const liveOptions = { ...options, domain };
    validateProbe(liveOptions);
    const [dns, probe] = await Promise.all([checkDns(items, dependencies), runProbe(liveOptions, dependencies)]);
    items = [...dns, ...probe];
  } else items.push(
    { id: 'send', status: 'not_checked', nextSteps: ['Configure a verified sender and an explicit provider API credential; run the live test only for an owner-approved test inbox.'], evidence: { state: 'unchecked' } },
    { id: 'receive', status: 'not_checked', nextSteps: ['Enable receiving on an owner test mailbox in Resend and configure its readback API credential; the live test matches a fresh random subject and body.'], evidence: { state: 'unchecked' } },
  );
  return { domain, provider: options.provider, items };
}
