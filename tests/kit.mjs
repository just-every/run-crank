import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

/** Third-party APIs faked at the network edge: `routes` maps a host to a handler that
 * receives {method,url,headers,body} and returns a Response. Loopback passes through. */
export function fakeEdge() {
  const routes = new Map(), requests = [];
  const edge = async request => {
    const url = new URL(request.url);
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return undefined;
    const body = ['GET', 'HEAD'].includes(request.method) ? '' : await request.text();
    const entry = { method: request.method, url, headers: Object.fromEntries(request.headers), body };
    requests.push(entry);
    const handler = routes.get(url.host);
    return handler ? await handler(entry) : new Response('no fake for ' + url.host, { status: 599 });
  };
  return { routes, requests, edge, to: host => requests.filter(r => r.url.host === host) };
}
export const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

export async function publish(h, name, graph, expected = 201) {
  const workflow = await h.post('workflows', { name, graph }, h.owner, 201);
  const published = await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, expected);
  return { ...workflow, published };
}
export const hookUrl = async (h, workflow, input = {}) => (await h.post(`workflows/${workflow.id}/hooks`, input, h.owner, 201)).url;
/** Sends to a public inbound door (no session, no Origin). */
export async function deliver(h, url, init = {}) {
  if (init.body instanceof FormData) {
    // Encode multipart bytes here; the test dispatcher would stringify a FormData body.
    const encoded = new Response(init.body);
    init = { ...init, body: await encoded.arrayBuffer(), headers: { ...(init.headers ?? {}), 'content-type': encoded.headers.get('content-type') } };
  }
  const response = await h.mf.dispatchFetch(url, { redirect: 'manual', ...init });
  const text = await response.text(); let value; try { value = JSON.parse(text) } catch { value = text }
  return { status: response.status, value, text, headers: response.headers };
}
export async function until(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + label);
    await new Promise(r => setTimeout(r, 50));
  }
}
export const runs = async (h, workflow, query = '') => (await h.get(`workflow-runs?workflow=${workflow.id}${query}`)).runs;
export const settled = (h, runId) => until(async () => { const run = await h.get('workflow-runs/' + runId); return ['queued', 'running'].includes(run.status) ? null : run }, 'run ' + runId);
export const stepOf = (run, id) => run.steps.find(s => s.step_id === id);
export async function startRun(h, workflow, input) { return h.post(`workflows/${workflow.id}/run`, { input }, h.owner, 201) }
export const connection = (h, body) => h.post('connections', body, h.owner, 201);
/** Credentials for fakes are generated per run, so no secret-shaped literal is committed. */
export const fakeSecret = label => `${label}-${randomUUID()}`;

/** An owner explicitly quotes every cost component before releasing held work. */
export async function estimateHold(h, holdId, amounts = {}) {
  return h.post(`holds/${holdId}/estimate`, { cost: { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: amounts[kind] ?? '0', assumption: 'Local acceptance journey; network edges do not charge this installation' })) } });
}
