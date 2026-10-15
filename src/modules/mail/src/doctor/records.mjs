import { fail } from '../core/errors.mjs';
import { hostname, integer, object } from './common.mjs';

export const DNS_IDS = ['mx', 'spf', 'dkim', 'dmarc'];

export function record(value) {
  object(value, ['type', 'name', 'value', 'priority'], 'invalid_doctor_record');
  if (!['MX', 'TXT', 'CNAME'].includes(value.type) || typeof value.value !== 'string' || !value.value.trim() || value.value.length > 4096 || /[\x00-\x1f\x7f]/.test(value.value)) fail('invalid_doctor_record');
  const result = { type: value.type, name: hostname(value.name, true), value: value.value };
  if (value.type === 'MX') result.priority = integer(value.priority, 0, 65535, 'invalid_doctor_priority');
  else if (value.priority !== undefined) fail('invalid_doctor_priority');
  if (value.type !== 'TXT') result.value = hostname(value.value);
  return result;
}

export function recordPlan(input = {}) {
  object(input, DNS_IDS, 'invalid_doctor_records');
  const plan = {};
  let total = 0;
  for (const id of DNS_IDS) {
    const values = input[id] ?? [];
    if (!Array.isArray(values) || (total += values.length) > 32) fail('invalid_doctor_records');
    plan[id] = values.map(record);
    for (const item of plan[id]) {
      if ((id === 'mx' && item.type !== 'MX') || (id === 'dmarc' && (item.type !== 'TXT' || !item.name.startsWith('_dmarc.') || !/^v=DMARC1;/i.test(item.value))) ||
          (id === 'spf' && !(item.type === 'CNAME' || item.type === 'TXT' && /^v=spf1(?:\s|$)/i.test(item.value))) ||
          (id === 'dkim' && (!item.name.includes('._domainkey.') || !['TXT', 'CNAME'].includes(item.type)))) fail('invalid_doctor_record_kind');
    }
  }
  return plan;
}

export function dnsPlan(domain, provider, plan) {
  const setup = {
    mx: `Copy the receiving service's MX host and priority for ${domain}; sending and receiving MX may be different.`,
    spf: `Copy ${provider}'s exact SPF TXT or return-path CNAME name and value from domain setup; keep one SPF policy per name.`,
    dkim: `Copy every ${provider} DKIM selector and TXT public key or CNAME target from domain setup; no selector or key can be inferred.`,
    dmarc: `Choose a DMARC policy and supply its TXT record at _dmarc.${domain}; confirm alignment with your sending domain.`,
  };
  return DNS_IDS.map(id => ({
    id, status: plan[id].length ? 'pending' : 'not_checked', records: plan[id],
    nextSteps: [plan[id].length ? 'Review these explicit setup records, publish them through your DNS administrator, then request a live DNS check.' : setup[id]],
    evidence: { state: 'unchecked', expectedRecordsSupplied: plan[id].length > 0 },
  }));
}
