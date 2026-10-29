import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accessToken, policyEnvelope } from './crypto.mjs';
import { AGENT_CLASSES } from './surface.mjs';
import { phaseFixtures } from './fixtures.mjs';

export const VERSION = '2026-07-28';
export const DECISION = 'com.runeditrun/decision';
export const ERROR = 'com.runeditrun/error';
export const APPROVAL = 'com.runeditrun/approval';
export const subset = (actual, expected) => expected && typeof expected === 'object'
 ? actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => subset(actual[key], value))
 : isDeepStrictEqual(actual, expected);
export const classIds = items => (items ?? []).map(item => typeof item === 'string' ? item : item.class).sort();
export function errorCode(answer) {
 const error = answer.result?._meta?.[ERROR] ?? answer.message?.error?.data?._meta?.[ERROR] ?? answer.message?.error?.data ?? answer.message?.error;
 return typeof error === 'string' ? error : error?.code ?? answer.body?.code ?? null;
}
export function resolveArgs(value, outputs, { unresolved = false, sponsor, fixtures = {} } = {}) {
 if (Array.isArray(value)) return value.map(item => resolveArgs(item, outputs, { unresolved, sponsor, fixtures }));
 if (value && typeof value === 'object') {
  if ('$sponsor' in value) {
   const result = sponsor?.[value.$sponsor];
   if (!['id', 'email'].includes(value.$sponsor) || typeof result !== 'string' || !result) throw new Error(`Sponsor reference ${value.$sponsor} is unavailable`);
   return result;
  }
  if ('$from' in value || '$fixture' in value) {
   const key = value.$fixture ?? value.$from, values = '$fixture' in value ? new Map(Object.entries(fixtures)) : outputs;
   if (!values.has(key)) {
    if ('$fixture' in value && unresolved) return `unresolved-fixture-${key}`;
    if ('$fixture' in value) throw new Error('A required native phase fixture is unavailable');
    if (unresolved) return `unresolved-${value.$from}`;
    throw new Error(`Reference ${value.$from} has no structuredContent in this phase`);
   }
   let result = values.get(key);
   for (const part of value.pointer.split('/').slice(1)) result = result?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
   if (result === undefined) throw new Error('A journey reference is missing');
   return structuredClone(result);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveArgs(item, outputs, { unresolved, sponsor, fixtures })]));
 }
 return value;
}
async function responseBody(response) {
 const raw = await response.text();
 if (response.headers.get('content-type')?.includes('text/event-stream')) {
  const messages = raw.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(value => JSON.parse(value));
  return messages.findLast(item => item.id !== undefined) ?? messages.at(-1) ?? {};
 }
 try { return JSON.parse(raw); } catch { return { nonJson: true }; }
}

export function createProtocol(context) {
 let requestId = 0;
 context.calls = [];
 context.sponsor = { email: context.person.email.toLowerCase() };
 context.add = (id, ok, detail) => context.points.push({ id, ok: Boolean(ok), ...(!ok ? { detail: String(detail ?? 'Contract assertion failed') } : {}) });
 context.phase = async (name, fn) => {
  try { await fn(); } catch (error) { context.add(name, false, error.message); }
 };
 context.request = async (path, init = {}) => {
  // A 429 is a capacity refusal, not an action result. Honor only a bounded,
  // explicit Retry-After; never replay an application or policy refusal.
  for (let attempt = 0; ; attempt++) {
   const response = await context.fetch(new URL(path, `${context.origin}/`).href, { redirect: 'manual', ...init });
   if (response.status !== 429) return response;
   const header = response.headers.get('retry-after'), delay = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : NaN;
   await response.body?.cancel();
   if (attempt >= 2 || !Number.isFinite(delay) || delay < 0 || delay > 60_000) throw new Error('429 capacity refusal without a bounded Retry-After (maximum 60 seconds, two retries)');
   await new Promise(resolve => setTimeout(resolve, delay));
  }
 };
 context.personRequest = async (path, { headers, ...init } = {}) => context.request(path, { ...init, headers: { Origin: context.origin, Cookie: context.person.cookie, 'Content-Type': 'application/json', ...headers } });
 context.personJson = async path => { const response = await context.personRequest(path); if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return responseBody(response); };
 context.decideApproval = async (pending, action = 'approve') => {
  if (!['approve', 'reject'].includes(action)) throw new Error('Approval decision must be approve or reject');
  const handle = pending.result?._meta?.[APPROVAL], path = `/agents/api/approvals/${encodeURIComponent(handle.id)}`;
  const { approval } = await context.personJson(path);
  const valid = approval?.id === handle.id && approval.decision_id === pending.decision?.id && approval.revision === pending.decision?.revision && /^[a-f0-9]{64}$/.test(approval.summary_sha256);
  context.add(`BASE-AGENT-008.5.summary.${handle.id}`, valid, 'The person approval must expose its exact decision, revision and summary SHA-256.');
  if (!valid) throw new Error('Cannot decide an approval without its exact summary evidence');
  const response = await context.personRequest(`${path}/${action}`, { method: 'POST', body: JSON.stringify({ revision: approval.revision, summary_sha256: approval.summary_sha256 }) });
  const body = await responseBody(response);
  if (response.ok && action === 'approve' && body.approval?.state === 'executed') context.calls.push({
   kind: 'approval/execute', name: approval.tool, decision: structuredClone(pending.decision), approvalId: handle.id, principal: pending.principal,
  });
  return { ok: response.ok, status: response.status, body };
 };
 context.mcp = async (method, params = {}, options = {}) => {
  const client = options.client === undefined ? undefined : context.clients.get(options.client);
  if (options.client !== undefined && !client) throw new Error('A required native client fixture is unavailable');
  const { token = client?.token ?? await accessToken(context), version = VERSION, headers = {}, track = true } = options;
  const principal = client && options.token === undefined ? { agent: client.agent, clientId: client.clientId, consent: null, sponsor: context.sponsor.id } : undefined;
  const id = ++requestId, name = method === 'resources/read' ? params.uri : params.name;
  const response = await context.request('/mcp', { method: 'POST', headers: {
   Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Origin: context.origin,
   'MCP-Protocol-Version': version, 'Mcp-Method': method,
   ...(['tools/call', 'resources/read', 'prompts/get'].includes(method) && name ? { 'Mcp-Name': name } : {}),
   ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: version === '2025-11-25' ? params : { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } }, 'io.modelcontextprotocol/clientInfo': { name: 'rer-agent-conformance', version: '1' }, ...params._meta } } }) });
  const body = await responseBody(response), result = body.result, decision = result?._meta?.[DECISION] ?? body.error?.data?._meta?.[DECISION];
  const answer = { status: response.status, headers: response.headers, body, message: body, result, decision, principal };
  if (['tools/call', 'resources/read'].includes(method) && track && (response.status !== 401 || typeof body.error?.data?.code === 'string')) context.calls.push({
   kind: method, name: method === 'resources/read' ? 'resources/read' : params.name,
   args: structuredClone(method === 'resources/read' ? { uri: params.uri } : params.arguments ?? {}),
   decision: structuredClone(decision ?? null), code: errorCode(answer), result: structuredClone(result), principal,
   approval: structuredClone(result?._meta?.[APPROVAL] ?? body.error?.data?.approval ?? null),
   pending: result?.resultType === 'input_required' || method === 'resources/read' && errorCode(answer) === 'approval_required',
  });
  return answer;
 };
 context.proof = async (name, args, handoff, clientLabel) => {
  const tool = context.surface.tools.find(tool => tool.name === name);
  if (!tool?.proof) return {};
  if (typeof context.prove !== 'function') throw new Error(`${name} requires the seed-declared verification.proof module`);
  const reference = await context.prove({ tool: name, args, kind: tool.proofKind, handoff, origin: context.origin, agentId: clientLabel === undefined ? context.agentId : context.clients.get(clientLabel)?.agent.id, request: (path, init) => {
   const url = new URL(path, context.origin);
   if (url.origin !== context.origin) throw new Error('Native proof test request must use the fresh installation origin');
   return context.personRequest(url.href, init);
  } });
  if (typeof reference !== 'string' || !reference) throw new Error('Native proof test hook must return a reference');
  return { proofReference: reference };
 };
 context.tool = (name, args, options) => context.mcp('tools/call', { name, arguments: args, ...(options?.proofReference ? { _meta: { 'com.runeditrun/native-proof': options.proofReference } } : {}), ...(options?.requestState === undefined ? {} : { requestState: options.requestState }) }, options);
 context.resolve = (value, outputs = new Map(), options = {}) => resolveArgs(value, outputs, { ...options, sponsor: context.sponsor, fixtures: context.fixtureValues });
 context.args = (step, outputs, options) => {
  const args = context.resolve(step.args, outputs, options);
  if (!context.surface.tools.find(tool => tool.name === step.tool)?.readOnly) args.idempotency_key = randomUUID();
  return args;
 };
 context.witness = async () => {
  const answer = await context.tool(context.surface.witness.tool, context.resolve(context.surface.witness.args));
  if (answer.result?.isError || answer.result?.structuredContent === undefined) throw new Error(`Witness ${context.surface.witness.tool} failed (${errorCode(answer) ?? answer.status})`);
  return answer.result.structuredContent;
 };
 context.adopt = async (document, options = {}) => {
  const signed = await policyEnvelope(context, document, options);
  const response = await context.request('/api/rer/agent-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: signed.policy }) });
  const body = await responseBody(response);
  if (!response.ok) throw new Error(`Policy adoption failed: HTTP ${response.status} (${typeof body.code === 'string' ? body.code : 'invalid response'})`);
  context.seq = signed.payload.seq; context.revision = signed.payload.revision; context.document = document;
  const expectedClasses = [...new Set(context.surface.tools.flatMap(tool => tool.classes))];
  const actualClasses = body.door?.classes;
  const validClasses = Array.isArray(actualClasses) && new Set(actualClasses.map(row => row?.class)).size === actualClasses.length && actualClasses.every(row =>
   row && Object.keys(row).sort().join(',') === 'class,tools' && AGENT_CLASSES.includes(row.class) && Array.isArray(row.tools) &&
   isDeepStrictEqual([...row.tools].sort(), context.surface.tools.filter(tool => tool.classes.includes(row.class)).map(tool => tool.name).sort().slice(0, 20))) &&
   expectedClasses.every(cls => actualClasses.some(row => row.class === cls));
  context.add(`BASE-AGENT-007.7.adopt.${context.seq}`, Object.keys(body).sort().join(',') === 'adopted,door' && isDeepStrictEqual(body.adopted, { seq: context.seq, revision: context.revision }) && validClasses, 'Policy answer must contain exactly adopted {seq,revision} and catalogue classes with the exact declared tool mappings; resource-only classes have no tools.');
  return signed;
 };
 phaseFixtures(context, context.prepare);
 return context;
}
