import { prepareStoppedCalls, stoppedCallsPhase } from './business-stop.mjs';
import { randomUUID, webcrypto } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { seconds, signJws } from './crypto.mjs';
import { auditRows } from './audit-rows.mjs';

const liveKeys = ['id','seq','at','tool','disposition','outcome','code','revision','classes','agent','consent','execution_of','replay_of','approval','review','resources','resource_count'].sort();
const erasedKeys = ['id','seq','at','erased','tool','classes','disposition','agent'].sort();
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), expected);

/** Exercise the signed pull against the same hosted door and its native audit. */
export async function relayPhase(c) {
 const path = '/api/rer/agent-decisions', iat = seconds(c.now);
 const payload = { v:1, iss:c.signer.issuer, aud:c.origin, sub:c.signer.installationId, business:c.business, after:0, limit:200, iat, exp:iat+60, jti:randomUUID() };
 const sign = value => signJws(c.signer.privateKey, c.signer.kid, 'rer-agent-decisions+jwt', value);
 const request = pull => c.request(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pull}) });
 const pull = await sign(payload), first = await request(pull), raw = await first.text();
 c.add('BASE-AGENT-009.relay.route', first.status === 200, `Signed decision pull must return 200, got ${first.status}; the people adapter must implement people.businessStopped() and positively return false while paired.`);
 if (first.status !== 200) return;
 let page = JSON.parse(raw), after = 0;
 const projections = [];
 for (let count = 0; ; count++) {
  const shaped = keys(page, ['cursor','decisions','head','more']) && Array.isArray(page.decisions) && page.decisions.length <= 200 &&
   Number.isSafeInteger(page.head) && page.head >= 0 && Number.isSafeInteger(page.cursor) && page.cursor >= after &&
   page.cursor === (page.decisions.at(-1)?.seq ?? after) && page.more === (page.cursor < page.head) &&
   Buffer.byteLength(JSON.stringify(page)) <= 65536 && page.decisions.every((row, index, rows) =>
    keys(row, row.erased === true ? erasedKeys : liveKeys) && Number.isSafeInteger(row.seq) && row.seq > (rows[index-1]?.seq ?? after));
  c.add(`BASE-AGENT-009.relay.page.${count}`, shaped, 'Decision page must be closed, ordered, bounded and carry its exact cursor and head.');
  if (!shaped) return;
  projections.push(...page.decisions);
  if (!page.more) break;
  if (count >= 99 || page.cursor <= after) throw new Error('Decision relay did not advance within 100 pages');
  after = page.cursor;
  const response = await request(await sign({...payload, after}));
  if (response.status !== 200) throw new Error(`Decision page HTTP ${response.status}`);
  page = await response.json();
 }
 const audit = (await auditRows(c, {agents:[null], includeFixtures:true})).rows;
 const expected = audit.filter(row => !c.unattributedAuditIds?.has(row.id) && (row.door === 'mcp' && row.consent != null || row.tombstone && projections.some(item => item.id === row.id)));
 c.add('BASE-AGENT-009.relay.unattributed', projections.every(row => !c.unattributedAuditIds?.has(row.id)), 'Calls before the first adopted envelope must stay out of the Business feed.');
 const reviews = new Map((expected.some(row => row.review) ? (await c.personJson('/agents/api/reviews')).reviews : []).map(row => [row.id,row]));
 c.add('BASE-AGENT-009.relay.count', projections.length > 0 && projections.length === expected.length && new Set(projections.map(row => row.id)).size === projections.length, 'Exactly one projection must exist per Business MCP audit, including erased decisions.');
 for (const row of expected) {
  const projected = projections.find(item => item.id === row.id);
  const common = {id:row.id,seq:projected?.seq,at:row.at,tool:row.tool,classes:row.classes.map(item=>item.class),disposition:row.decision,agent:row.agent.id};
  let value;
  if (row.tombstone) value = {...common,erased:true};
  else {
   const links = row.tool === 'resources/read' && typeof row.resource === 'string' ? [row.resource] : row.resources ?? [];
   const approval = row.approval ? (await c.personJson(`/agents/api/approvals/${encodeURIComponent(row.approval.id)}`)).approval : null;
   value = {...common,outcome:row.outcome,code:row.code && /^[a-z][a-z0-9_]{0,63}$/.test(row.code)?row.code:null,revision:row.revision,consent:row.consent,
    execution_of:row.decision_id,replay_of:row.replay_of,approval:approval?{state:approval.state,expires_at:approval.expires_at}:null,
    review:row.review?{state:reviews.get(row.review.id)?.state}:null,resources:links.filter(uri=>typeof uri==='string' && uri.length<=512).slice(0,8),resource_count:row.tool==='resources/read'?links.length:row.resource_count??links.length};
  }
  c.add(`BASE-AGENT-009.relay.decision.${row.id}`, isDeepStrictEqual(projected,value), 'Projection must equal only the public audit fields and current approval/review state.');
 }
 const replay = await request(pull);
 c.add('BASE-AGENT-009.relay.replay', replay.status === 200 && await replay.text() === raw, 'The same pull must return byte-identical content.');
 const empty = await request(await sign({...payload,after:page.cursor}));
 c.add('BASE-AGENT-009.relay.cursor', empty.status === 200 && isDeepStrictEqual(await empty.json(),{decisions:[],cursor:page.cursor,head:page.head,more:false}), 'Pulling after the final cursor must return an empty page.');
 const foreign = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const refused = await request(await signJws(foreign.privateKey,c.signer.kid,'rer-agent-decisions+jwt',payload));
 c.add('BASE-AGENT-009.relay.foreign', refused.status === 401 && isDeepStrictEqual(await refused.json(),{code:'relay_unauthenticated'}), 'A foreign signature must return only 401 relay_unauthenticated.');
}

/** Detach while relay trust and the old policy remain, then probe without renewal. */
export async function relayStoppedPhase(c) {
 let held = [];
 await c.phase('BASE-AGENT-004.stop.prepare', async () => { held = await prepareStoppedCalls(c); });
 const iat = seconds(c.now);
 const signed = (typ, payload) => signJws(c.signer.privateKey, c.signer.kid, typ, payload);
 const request = (path, body) => c.fetch(new URL(path, c.origin).href, {
  method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body), redirect:'manual',
 });
 const pull = await signed('rer-agent-decisions+jwt', {
  v:1, iss:c.signer.issuer, aud:c.origin, sub:c.signer.installationId, business:c.business,
  after:0, limit:200, iat, exp:iat+60, jti:randomUUID(),
 });
 const paired = await request('/api/rer/agent-decisions', {pull});
 c.add('BASE-AGENT-009.relay.before-stop', paired.status === 200,
  `Paired relay before detachment must return 200, got ${paired.status}; people.businessStopped() must positively return false.`);
 await paired.body?.cancel();
 const settingsIat = seconds();
 const settings = await signed('rer-business-settings+jwt', {
  v:1, iss:c.signer.issuer, aud:c.origin, sub:c.signer.installationId, business:c.business, email:c.person.email, owner_id:c.person.sub,
  jti:randomUUID(), iat:settingsIat, exp:settingsIat+300, rev:2, values:{}, logo:null, team:null, detached:true,
 });
 const detached = await request('/api/rer/business-settings', {settings});
 c.add('BASE-AGENT-009.relay.detach', detached.status === 200, `Signed Business detachment must be accepted before the stopped relay probe, got ${detached.status}.`);
 await detached.body?.cancel();
 if (detached.status !== 200) return;
 await c.phase('BASE-AGENT-004.stop', () => stoppedCallsPhase(c, held));
 const stopped = await request('/api/rer/agent-decisions', {pull});
 c.add('BASE-AGENT-009.relay.stopped', stopped.status === 404 && await stopped.text() === '',
  'A detached Business must receive empty 404 with its old policy and relay trust retained; people.businessStopped() must read the durable stop.');
}
