import { createHash, randomUUID, webcrypto } from 'node:crypto';

export const CATALOGUE = 'rer-agent-classes/1';
export function canonical(value) {
 if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
 if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
 return JSON.stringify(value);
}
export async function signJws(privateKey, kid, typ, payload) {
 const input = [Buffer.from(JSON.stringify({ alg: 'ES256', typ, kid })).toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url')].join('.');
 const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(input));
 return `${input}.${Buffer.from(signature).toString('base64url')}`;
}
export function seconds(now) {
 const value = typeof now === 'function' ? now() : now ?? Date.now();
 return Math.floor((value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value) / 1000);
}
export async function accessToken(context, overrides = {}) {
 const iat = seconds(context.now);
 return signJws(context.signer.privateKey, context.signer.kid, 'at+jwt', {
  iss: context.signer.issuer, aud: `${context.origin}/mcp`, sub: context.person.sub, email: context.person.email.toLowerCase(),
  act: { sub: context.agentId, name: 'Agent door conformance', specialist: context.surface.specialist }, client_id: 'rer-agent-conformance',
  scope: [...new Set([...context.surface.tools.map(tool => tool.scope), ...(context.resourceScopes ?? []), 'events:read'])].join(' '), business: context.business,
  consent: context.consent, jti: randomUUID(), iat, exp: iat + 300, ...overrides,
 });
}
export const autonomousPolicy = () => ({ schema: 'rer-agent-policy/1', catalogue: CATALOGUE, rules: [{ id: 'all', class: '*', do: 'autonomous' }], spend: { none: true } });
export const heldPolicy = () => ({ schema: 'rer-agent-policy/1', catalogue: CATALOGUE, rules: [{ id: 'all', class: '*', do: 'approval', approver: ['sponsor'], wait: 'PT1H' }, { id: 'standard', class: 'standard', do: 'review' }], reviewers: ['sponsor'], spend: { none: true } });
export async function policyEnvelope(context, document, { paused = false, revoked, revision = context.revision + 1, seq = context.seq + 1, ...overrides } = {}) {
 const iat = seconds(context.now);
 const revision_signature = document === null ? null : await signJws(context.signer.privateKey, context.signer.kid, 'rer-agent-policy-revision+jwt', {
  business: context.business, revision, document_sha256: createHash('sha256').update(canonical(document)).digest('hex'),
 });
 const payload = { v: 1, iss: context.signer.issuer, aud: context.origin, sub: context.signer.installationId, business: context.business, seq, revision, paused, catalogue: CATALOGUE, document, revision_signature, iat, exp: iat + 300, ...(revoked === undefined ? {} : { revoked }), ...overrides };
 return { payload, policy: await signJws(context.signer.privateKey, context.signer.kid, 'rer-agent-policy+jwt', payload) };
}
