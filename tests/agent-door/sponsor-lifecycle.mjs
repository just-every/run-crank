import assert from 'node:assert/strict';
import {randomUUID, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {serveHosted, HOSTED_ORIGIN} from '../../node_modules/@runeditrun/rer/cli/hosted-output.mjs';
import {accessToken, autonomousPolicy, seconds, signJws} from '../../src/modules/agent-door/conformance/crypto.mjs';
import {createProtocol, errorCode} from '../../src/modules/agent-door/conformance/protocol.mjs';
import {confirmation, headers} from './sponsors.mjs';

const value = answer => {
 assert.equal(answer.status, 200);
 assert.ok(!answer.result?.isError, errorCode(answer));
 assert.ok(answer.result?.structuredContent);
 return answer.result.structuredContent;
};

// A separate disposable production installation lets the journey exercise
// irreversible native identity transitions without changing the CORE owner.
export async function verifySponsorLifecycle() {
 const pair = await webcrypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
 const kid = randomUUID(), installationId = randomUUID(), issuer = 'https://synthetic-crank-business.invalid';
 const {kty, crv, x, y} = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
 const publicKeys = {[kid]: {kty, crv, x, y, kid, alg: 'ES256', use: 'sig'}};
 const address = name => name + String.fromCharCode(64) + 'example.invalid';
 const email = address('synthetic-crank-owner'), ownerSub = randomUUID(), memberSub = randomUUID();
 const token = randomUUID() + randomUUID(), mail = [];
 const hosted = await serveHosted(process.cwd(), {bindings: {
  OWNER_EMAIL: email, SETUP_TOKEN: token, SESSION_SECRET: randomUUID() + randomUUID(),
  RER_OWNER_CLAIM_ISSUER: issuer, RER_OWNER_CLAIM_INSTALLATION_ID: installationId,
  RER_OWNER_CLAIM_PUBLIC_KEYS: JSON.stringify(publicKeys),
  RER_BUSINESS_TRUST: JSON.stringify({v: 1, issuer, audience: HOSTED_ORIGIN, subject: installationId, email, keys: publicKeys}),
 }, outboundService: async request => {
  assert.equal(new URL(request.url).origin, 'https://api.resend.com');
  mail.push(await request.json());
  return Response.json({id: randomUUID()});
 }});
 const origin = hosted.origin;
 const request = (url, init) => hosted.fetch(new URL(url).href.slice(origin.length + 1), init);
 const native = async (path, body, cookie, status = 200) => {
  const response = await request(origin + path, {headers: headers(origin, cookie), redirect: 'manual',
   ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)})});
  assert.equal(response.status, status, 'Sponsor lifecycle ' + path);
  const session = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  const text = await response.text();
  return {cookie: session, body: text ? JSON.parse(text) : null};
 };
 const login = async email => {
  await native('/auth/magic-link', {email}, undefined, 202);
  return (await native('/auth/confirm', {token: confirmation(mail, origin)}, undefined, 303)).cookie;
 };
 const memberEmail = address('synthetic-crank-builder');
 let revision = 0;
 const roster = async team => {
  const iat = seconds();
  const settings = await signJws(pair.privateKey, kid, 'rer-business-settings+jwt', {
   v: 1, iss: issuer, aud: origin, sub: installationId, business: 'synthetic-crank-business', email,
   owner_id: ownerSub, jti: randomUUID(), iat, exp: iat + 300, rev: ++revision, values: {}, logo: null, team,
  });
  return native('/api/rer/business-settings', {settings});
 };
 try {
  let ownerCookie = (await native('/auth/bootstrap', {token, displayName: 'Synthetic Crank owner'}, undefined, 303)).cookie;
  const team = [{id: memberSub, email: memberEmail, name: 'Synthetic Crank builder', role: 'member', invite: 1}];
  await roster(team);
  let memberCookie = (await native('/auth/confirm', {token: confirmation(mail, origin)}, undefined, 303)).cookie;
  const operators = (await native('/auth/operators', undefined, ownerCookie)).body;
  const member = operators.find(person => person.email === memberEmail), owner = operators.find(person => person.email === email);
  assert.ok(member?.id && owner?.id && member.id !== owner.id);
  await native('/api/crank/team/' + member.id, {grants: [{role: 'builder', workflow_ids: ['workspace:production'], connection_ids: []}]}, ownerCookie);
  const surface = JSON.parse(await readFile('agent-surface.json', 'utf8'));
  const signer = {issuer, installationId, kid, privateKey: pair.privateKey};
  const protocol = person => createProtocol({fetch: request, origin, surface, signer, person,
   business: 'synthetic-crank-business', consent: randomUUID(), points: [], agentId: 'synthetic-crank-' + randomUUID(), seq: 0, revision: 0, listed: new Map()});
  const a = protocol({email, sub: ownerSub, cookie: ownerCookie});
  const b = protocol({email: memberEmail, sub: memberSub, cookie: memberCookie});
  await a.adopt(autonomousPolicy());
  assert.equal((await a.mcp('tools/list')).status, 200);
  const args = {name: 'Synthetic private sponsor draft', graph: {trigger: {type: 'manual'}, steps: [{id: 'shape', type: 'map', input: {value: 'synthetic-crank-private'}}]}};
  const draft = value(await b.tool('crank.workflows.create', {...args, idempotency_key: randomUUID()}));
  const own = () => b.tool('crank.workflows.get', {workflow_id: draft.id});
  assert.equal(value(await own()).owner_id, member.id);
  const before = (await native('/api/crank/workflows/' + draft.id, undefined, ownerCookie)).body;
  assert.equal(before.prepared_by.for.id, member.id);

  // A genuine self-service address change retains the durable Business subject.
  const oldToken = await accessToken(b), changed = address('synthetic-crank-current');
  memberCookie = await login(memberEmail);
  await native('/auth/email', {email: changed}, memberCookie);
  assert.equal((await b.mcp('tools/list', {}, {token: oldToken})).status, 401);
  b.person.email = changed;
  assert.equal(value(await own()).owner_id, member.id);
  await roster([{...team[0], email: changed}]);
  assert.equal(value(await own()).owner_id, member.id);

  // Native ownership moves do not rebind the Business owner's subject.
  ownerCookie = await login(email);
  await native('/auth/operator/role', {operatorId: member.id, role: 'owner'}, ownerCookie);
  memberCookie = await login(changed);
  await native('/auth/operator/role', {operatorId: owner.id, role: 'admin'}, memberCookie);
  assert.equal(value(await a.tool('crank.catalog.list', {})).apps.length > 0, true);
  await native('/agents/api/agents', undefined, memberCookie, 403);
  ownerCookie = await login(email);
  const inventory = (await native('/agents/api/agents', undefined, ownerCookie)).body;
  assert.equal(inventory.agents.find(agent => agent.id === a.agentId)?.sponsor.id, owner.id);
  assert.equal(inventory.agents.find(agent => agent.id === b.agentId)?.sponsor.id, member.id);
  await native('/auth/operator/role', {operatorId: owner.id, role: 'owner'}, memberCookie);
  ownerCookie = await login(email);
  await native('/auth/operator/role', {operatorId: member.id, role: 'member'}, ownerCookie);

  await native('/auth/operator/status', {operatorId: member.id, status: 'inactive'}, ownerCookie);
  assert.equal((await b.mcp('tools/list')).status, 401);
  assert.equal((await own()).status, 401);
  assert.deepEqual((await native('/api/crank/workflows/' + draft.id, undefined, ownerCookie)).body, before);
  await native('/auth/operator/status', {operatorId: member.id, status: 'active'}, ownerCookie);
  assert.equal(value(await own()).owner_id, member.id);

  // Removing the signed Business binding fences even a separately reactivated
  // native account. Replaying the older roster cannot restore that binding.
  await roster([]);
  await native('/auth/operator/status', {operatorId: member.id, status: 'active'}, ownerCookie);
  assert.equal((await b.mcp('tools/list')).status, 401, 'Removed Business membership must refuse discovery');
  const detached = await own();
  assert.ok([401, 403].includes(detached.status));
  const replayIat = seconds();
  const replay = await signJws(pair.privateKey, kid, 'rer-business-settings+jwt', {
   v: 1, iss: issuer, aud: origin, sub: installationId, business: b.business, email, owner_id: ownerSub,
   jti: randomUUID(), iat: replayIat, exp: replayIat + 300, rev: revision - 1, values: {}, logo: null, team,
  });
  await native('/api/rer/business-settings', {settings: replay}, undefined, 409);
  assert.equal((await b.mcp('tools/list')).status, 401);
  assert.deepEqual((await native('/api/crank/workflows/' + draft.id, undefined, ownerCookie)).body, before);
  const audit = (await native('/agents/api/audit', undefined, ownerCookie)).body;
  assert.ok(audit.rows.some(row => row.sponsor?.id === member.id && row.outcome === 'done'));
  assert.equal(audit.differs_from_policy, 0);
  assert.ok(a.points.every(point => point.ok));
 } finally { await hosted.close(); }
}
