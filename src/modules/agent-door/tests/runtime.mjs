import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, webcrypto } from 'node:crypto';
import { signJws, policyEnvelope, autonomousPolicy, accessToken } from '../conformance/crypto.mjs';
const require = createRequire(new URL('../../../default-seed/package.json', import.meta.url));
const { build } = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { unstable_splitSqlQuery: split } = require('wrangler');
const output = await build({ entryPoints: [fileURLToPath(new URL('./seed.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
export async function runtime({ paired = true, limits, resourceScope = 'records:read', ring, seed = 'synthetic', toolNames, revisionType, nativeTargets = false, sponsorSurface = false, queueContext = false } = {}) {
 const origin = 'https://synthetic-base-1.invalid', issuer = 'https://synthetic-base-2.invalid', installationId = 'synthetic-base-1', kid = 'synthetic-base-1';
 const keys = ring ?? await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
 const publicKey = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
 const businessTrust = { v:1,issuer,audience:origin,subject:installationId,keys:{[kid]:publicKey} };
 const signer = { issuer, installationId, kid, privateKey: keys.privateKey };
 const localToken = randomBytes(32).toString('hex');
 const config = { origin, limits, resourceScope, seed, toolNames, revisionType, nativeTargets, sponsorSurface, queueContext, OWNER_EMAIL: 'synthetic-base-1@example.com', SETUP_TOKEN: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex'), MAIL_FROM: 'synthetic-base-1@example.com', ipLimit: 1000, emailLimit: 1000 };
 const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: output.outputFiles[0].text, compatibilityDate: '2026-09-01', d1Databases: { DB: 'synthetic-base-1' }, bindings: { LOCAL_TOKEN: localToken, CONFIG: JSON.stringify(config), BUSINESS_TRUST: JSON.stringify(businessTrust), TRUST: JSON.stringify(paired ? { issuer, installationId, appOrigin: origin, publicKeys: { [kid]: publicKey } } : null) } }));
 try {
  const db = await mf.getD1Database('DB');
  for (const file of ['../../operator-auth/accounts/schema/operator-auth.sql','../schema/agent-door.sql','../../business-settings/schema/0001_business_settings.sql','../../business-settings/schema/0002_business_people.sql']) for (const sql of split(await readFile(new URL(file, import.meta.url), 'utf8'))) await db.prepare(sql).run();
  for (const sql of ['CREATE TABLE test_jobs(id TEXT PRIMARY KEY,saved TEXT)', 'CREATE TABLE test_effects(id TEXT PRIMARY KEY,saved TEXT)', 'CREATE TABLE test_grants(agent TEXT PRIMARY KEY,scopes TEXT)', 'CREATE TABLE test_mail(email TEXT,body TEXT)', 'CREATE TABLE test_records(id TEXT PRIMARY KEY,value TEXT,version INTEGER,exposure TEXT)', 'CREATE TABLE test_sent(id TEXT)', 'CREATE TABLE test_revisions(id TEXT PRIMARY KEY,token TEXT)', 'CREATE TABLE test_callbacks(id TEXT PRIMARY KEY,event TEXT)', 'CREATE TABLE test_contexts(kind TEXT,person TEXT,agent TEXT,actor TEXT,approvers TEXT,audit TEXT,consent TEXT)']) await db.prepare(sql).run();
  const fetch = (url, init = {}) => mf.dispatchFetch('http://localhost/__dispatch', { method: 'POST', body: JSON.stringify({ url: new URL(url, origin).href, method: init.method ?? 'GET', headers: { Host: new URL(origin).host, 'CF-Connecting-IP': '192.0.2.1', ...Object.fromEntries(new Headers(init.headers)) }, ...(init.body ? { body: init.body } : {}) }), redirect: 'manual' });
  const post = (path, body, headers = {}) => fetch(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const bootstrap = await post('/auth/bootstrap', { token: config.SETUP_TOKEN, displayName: 'Synthetic Person' });
  if (bootstrap.status !== 303) throw new Error(`Bootstrap ${bootstrap.status}: ${await bootstrap.text()}`);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0]; await bootstrap.body?.cancel();
  const c = { ring:keys, signer, origin, consent:crypto.randomUUID(), person: { email: config.OWNER_EMAIL, cookie, sub:crypto.randomUUID() }, agentId: 'synthetic-base-1', business: 'synthetic-base-1', seq: 0, revision: 0, surface: { specialist: 'operations', tools: [{ scope: 'records:read' },{ scope:'records:write' }] }, now: Date.now() };
  let settingsRev = 0;
  const settings = async (overrides = {}) => {
   const iat = Math.floor(Date.now()/1000);
   const document = { v:1,iss:issuer,aud:origin,sub:installationId,business:c.business,email:config.OWNER_EMAIL,jti:crypto.randomUUID(),iat,exp:iat+3600,rev:++settingsRev,values:{display_name:'Synthetic Base'},logo:null,team:null,owner_id:c.person.sub,...overrides };
   const response = await post('/api/rer/business-settings',{settings:await signJws(keys.privateKey,kid,'rer-business-settings+jwt',document)});
   return {status:response.status,body:await response.json()};
  };
  const pairedSettings = await settings();
  if (pairedSettings.status !== 200) throw new Error(`Settings mapping ${JSON.stringify(pairedSettings)}`);
  let requestId = 0;
  const mcp = async (method, params = {}, opts = {}) => {
   const version = opts.version ?? '2026-07-28', token = opts.token === undefined ? await accessToken(c) : opts.token;
   const body = { jsonrpc: '2.0', id: ++requestId, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } }, ...params._meta } } };
   const response = await post('/mcp', body, { 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...(['tools/call','prompts/get','resources/read'].includes(method) ? { 'Mcp-Name': params.name ?? params.uri } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers });
   const message = await response.json(); return { status: response.status, headers: response.headers, ...message };
  };
  const person = async (path, body, extra = {}) => { const response = body === undefined ? await fetch(path, { headers: { cookie, ...extra } }) : await post(path, body, { cookie, ...extra }); return { status: response.status, body: await response.json() }; };
  const adopt = async (document = autonomousPolicy(), options = {}) => { const value = await policyEnvelope(c, document, options); const response = await post('/api/rer/agent-policy', { policy: value.policy }); const body = await response.json(); if (response.ok) { c.seq = value.payload.seq; c.revision = value.payload.revision; } return { status: response.status, body, ...value }; };
  const signIn = async email => {
   await post('/auth/magic-link',{email});
   const message = await db.prepare('SELECT body FROM test_mail WHERE email=? ORDER BY rowid DESC LIMIT 1').bind(email).first();
   if (!message) throw new Error('No native sign-in delivery');
   const link = new URL(message.body.match(/https:\/\/[^\s]+/)[0]);
   const response = await post('/auth/confirm',{token:link.searchParams.get('token')});
   if (response.status !== 303) throw new Error(`Native confirmation ${response.status}: ${await response.text()}`);
   const signedCookie = response.headers.get('set-cookie').split(';')[0]; await response.body?.cancel(); return signedCookie;
  };
  const setNow = async now => { c.now = now; await post('/__clock', { now }); };
  await setNow(c.now);
  return { mf, db, c, localToken, fetch, post, mcp, person, adopt, setNow, settings, signIn, tool: (name, args, options) => mcp('tools/call', { name: `synthetic.${name}`, arguments: args }, options), token: overrides => accessToken(c, overrides), sign: (typ, payload, otherKid = kid) => signJws(keys.privateKey, otherKid, typ, payload), close: () => mf.dispose() };
 } catch (error) { await mf.dispose(); throw error; }
}
