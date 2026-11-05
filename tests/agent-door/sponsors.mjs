import assert from 'node:assert/strict';

// These handles belong only to the verifier's disposable installation. The
// reviewer adapter captures each declared mailbox at the paid network edge.
const people = new Map();
const responses = new Map();
let reviewers;
export const sponsor = label => people.get(label);
export const headers = (origin, cookie) => ({cookie, origin, 'content-type': 'application/json'});
export async function nativeJson({request, origin}, path, body, cookie, status = 200) {
 const response = await request(origin + path, {headers: headers(origin, cookie),
  ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)})});
 assert.equal(response.status, status, 'Native sponsor lifecycle: ' + path);
 return response.json();
}
export function confirmation(messages, origin) {
 const message = messages.at(-1);
 const link = message?.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)?.[1];
 assert.ok(link, 'The native invitation must reach the disposable mailbox');
 return new URL(link.replaceAll('&amp;', '&'), origin).searchParams.get('token');
}

export default async function initialize(context) {
 const {label, request, origin, email, sub, owner, mail} = context;
 if (label === 'owner') {
  people.clear(); responses.clear(); reviewers = context.reviewers;
  return request(origin + '/auth/bootstrap', {method: 'POST', redirect: 'manual',
   headers: headers(origin), body: JSON.stringify({token: context.token, displayName: context.displayName})});
 }
 if (sub === undefined) {
  // Business already sent the native invitation. Consume its ordinary link.
  const response = await request(origin + '/auth/confirm', {method: 'POST', redirect: 'manual',
   headers: headers(origin), body: JSON.stringify({token: confirmation(mail.read(), origin)})});
  assert.equal(response.status, 303);
  responses.set(label, {status: response.status, headers: new Headers(response.headers)});
  people.set(label, {email, mail});
  return response;
 }
 const session = await reviewers.initialize(label, owner);
 const operators = await nativeJson(context, '/auth/operators', undefined, owner.cookie);
 const person = operators.find(person => person.email === email);
 assert.ok(person?.id);
 people.set(label, {...people.get(label), sub, id: person.id, cookie: session.cookie});
 await nativeJson(context, '/api/crank/team/' + person.id, {grants: [
  {role: 'builder', workflow_ids: ['workspace:production'], connection_ids: []},
 ]}, owner.cookie);
 return new Response(null, responses.get(label));
}

export async function suspendFixture(context) {
 const person = sponsor('inactive');
 assert.ok(person?.sub && person.id);
 await nativeJson(context, '/auth/operator/status', {operatorId: person.id, status: 'inactive'}, context.cookie);
 return {inactive: {sub: person.sub, email: person.email}};
}
