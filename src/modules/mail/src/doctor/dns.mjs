import { fail } from '../core/errors.mjs';
import { bounded, hostname, readJson } from './common.mjs';
import { record } from './records.mjs';

const types = { MX: 15, TXT: 16, CNAME: 5 };

// DNS presentation strings can contain several quoted character strings.
export function decodeTxt(value) {
  if (typeof value !== 'string' || value.length > 16384) fail('doctor_dns_response_invalid');
  let result = '', offset = 0, chunks = 0;
  while (offset < value.length) {
    while (value[offset] === ' ') offset++;
    if (offset === value.length) break;
    if (value[offset++] !== '"') fail('doctor_dns_response_invalid');
    chunks++;
    let closed = false;
    while (offset < value.length) {
      const char = value[offset++];
      if (char === '"') { closed = true; break; }
      if (char !== '\\') { result += char; continue; }
      if (offset === value.length) fail('doctor_dns_response_invalid');
      const decimal = value.slice(offset, offset + 3);
      if (/^\d{3}$/.test(decimal)) {
        if (Number(decimal) > 255) fail('doctor_dns_response_invalid');
        result += String.fromCharCode(Number(decimal)); offset += 3;
      } else result += value[offset++];
    }
    if (!closed || (offset < value.length && value[offset] !== ' ')) fail('doctor_dns_response_invalid');
  }
  if (!chunks) fail('doctor_dns_response_invalid');
  return result;
}

/** Fixed public DNS resolver: no caller-controlled host or credentials. */
export async function resolveDns({ name, type, signal }, fetcher = globalThis.fetch) {
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name', name); url.searchParams.set('type', type);
  const response = await fetcher(url, { headers: { accept: 'application/dns-json' }, redirect: 'manual', signal });
  if (response.status !== 200) return { status: 'error' };
  const data = await readJson(response, 65536);
  if (!data || data.TC === true || ![0, 3].includes(data.Status)) return { status: 'error' };
  if (data.Status === 3) return { status: 'missing', records: [] };
  if (data.Answer !== undefined && (!Array.isArray(data.Answer) || data.Answer.length > 128)) return { status: 'error' };
  const records = [];
  for (const answer of data.Answer ?? []) {
    if (answer.type !== types[type] || hostname(answer.name, true) !== name) continue;
    let value = answer.data, priority;
    if (type === 'TXT') value = decodeTxt(value);
    if (type === 'MX') {
      const parts = /^(\d+)\s+(\S+)$/.exec(value);
      if (!parts) return { status: 'error' };
      priority = Number(parts[1]); value = parts[2];
    }
    // A null MX explicitly means this name does not accept mail.
    if (type === 'MX' && value === '.') continue;
    records.push(record({ type, name, value, ...(priority === undefined ? {} : { priority }) }));
  }
  return { status: records.length ? 'ok' : 'missing', records };
}

function same(a, b) {
  return a.type === b.type && a.name === b.name && a.value === b.value && a.priority === b.priority;
}

export async function checkDns(items, dependencies) {
  const resolver = dependencies.resolveDns ?? (query => resolveDns(query, dependencies.fetch));
  const cache = new Map();
  function lookup(expected) {
    const key = `${expected.type}:${expected.name}`;
    if (!cache.has(key)) cache.set(key, bounded(signal => resolver({ name: expected.name, type: expected.type, signal }), 8000)
      .then(result => {
        if (!result || !['ok', 'missing', 'error'].includes(result.status)) return { status: 'error' };
        if (result.status === 'error') return { status: 'error' };
        if (!Array.isArray(result.records) || result.records.length > 128) return { status: 'error' };
        const records = result.records.map(record).filter(item => item.name === expected.name && item.type === expected.type);
        if (result.status === 'missing' && records.length) return { status: 'error' };
        return { status: records.length ? 'ok' : 'missing', records };
      }).catch(() => ({ status: 'error' })));
    return cache.get(key);
  }
  return Promise.all(items.map(async item => {
    if (!item.records.length) return item;
    const checks = await Promise.all(item.records.map(async expected => {
      const found = await lookup(expected);
      let state = found.status === 'error' ? 'error' : found.status === 'missing' ? 'missing' : 'mismatch';
      if (found.status === 'ok') {
        const prefix = item.id === 'spf' ? /^v=spf1(?:\s|$)/i : item.id === 'dmarc' ? /^v=DMARC1;/i : null;
        const policies = prefix ? found.records.filter(row => row.type === 'TXT' && prefix.test(row.value)) : [];
        if (found.records.some(row => same(row, expected)) && policies.length <= 1) state = 'match';
      }
      return { type: expected.type, name: expected.name, state };
    }));
    const state = ['error', 'missing', 'mismatch'].find(value => checks.some(check => check.state === value)) ?? 'match';
    const next = {
      error: 'DNS lookup failed or returned malformed data. Check resolver availability and retry the DNS check; no record absence is inferred.',
      missing: 'Publish the missing records from provider setup, allow DNS propagation, then check again.',
      mismatch: 'Compare the published values and MX priorities with provider setup; remove duplicate SPF/DMARC policies and correct mismatches.',
      match: 'The queried records match this setup plan. Verify provider domain status and actual delivered authentication separately.',
    };
    return { ...item, status: state === 'match' ? 'pass' : 'fail', nextSteps: [next[state]], evidence: { state, checks } };
  }));
}
