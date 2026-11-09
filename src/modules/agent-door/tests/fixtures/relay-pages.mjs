import { webcrypto } from 'node:crypto';
import { signJws } from '../../conformance/crypto.mjs';

// Deterministic audit snapshots: mixed live/erased rows fit 200 per page;
// large Unicode resources force byte cuts, including an exact 65,536-byte edge.
export function relayFeed(kind) {
 const records = Array.from({ length: 205 }, (_, i) => {
  const row = { id: `synthetic-decision-${i}`, at: '2026-11-02T00:00:00.000Z',
   tool: 'synthetic.records.write', classes: [{ class: 'standard' }],
   decision: 'autonomous', agent: { id: 'synthetic-agent' }, outcome: 'done',
   code: null, revision: 1, consent: 'synthetic-consent', decision_id: null, replay_of: null,
   resources: kind === 'compact' ? [] : [`synthetic://record/${i}/${'é中😀"\\'.repeat(30 + i % 7)}`],
   resource_count: kind === 'compact' ? 0 : 1,
   ...(kind === 'compact' && i % 3 ? { tombstone: { erasure_id: 'synthetic-erasure', at: '2026-11-02T00:00:00.000Z' } } : {}) };
  return { business: 'synthetic-business', head: 295, sequence: i + 91,
   row: JSON.stringify(row), approval_state: null, expires_at: null, review_state: null };
 });
 if (kind === 'large') {
  // The first 81 rows total exactly 65,536 response bytes with cursor=171.
  // This fixed padding was calibrated against the original implementation.
  const row = JSON.parse(records[80].row);
  row.resources[0] += 'x'.repeat(144);
  records[80].row = JSON.stringify(row);
 }
 return records;
}

export async function relayReader(relay, records) {
 const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
 const trust = { issuer: 'https://synthetic-business.invalid', appOrigin: 'https://synthetic-seed.invalid',
  installationId: 'synthetic-installation', publicKeys: { synthetic: await webcrypto.subtle.exportKey('jwk', keys.publicKey) } };
 const now = Date.parse('2026-11-02T00:00:00.000Z');
 const rt = { now: () => now, options: { trust, people: { businessStopped: async () => false },
  db: { prepare: () => ({ bind: (_business, _partition, after, limit) => ({
   all: async () => {
    const page = records.filter(row => row.sequence > after).slice(0, limit);
    return { results: page.length ? page : [{ ...records[0], sequence: null, row: null }] };
   }
  }) }) } } };
 return async (cursor, count) => {
  const pull = await signJws(keys.privateKey, 'synthetic', 'rer-agent-decisions+jwt',
   { v: 1, iss: trust.issuer, aud: trust.appOrigin, sub: trust.installationId,
    business: 'synthetic-business', after: cursor, limit: count, iat: now / 1000, exp: now / 1000 + 60, jti: 'synthetic-pull' });
  const response = await relay(rt, new Request(trust.appOrigin + '/api/rer/agent-decisions',
   { method: 'POST', body: JSON.stringify({ pull }) }));
  if (response.status !== 200) throw Error(`relay returned ${response.status}`);
  return response.text();
 };
}
