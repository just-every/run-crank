import { auditRows } from './audit-rows.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Each round gets new native state, never a previous round's consumed values. */
export function phaseFixtures(c, prepare) {
 c.fixtureValues = {};
 c.clients = new Map();
 c.nativeAgents = new Set();
 c.fixtureAuditIds = new Set();
 c.prepare = async phase => {
  c.fixtureValues = {};
  c.clients.clear();
  if (!prepare) return;
  try {
   const before = new Set((await auditRows(c, { agents: [null], includeFixtures: true })).rows.map(row => row.id));
   const result = await prepare({ phase, tool: c.tool });
   if (!object(result) || Object.keys(result).some(key => !['values', 'clients'].includes(key)) || !object(result.values ?? {}) || !object(result.clients ?? {})) throw new Error('Native phase preparation must return {values,clients}.');
   for (const [label, client] of Object.entries(result.clients ?? {})) {
    if (!text(label) || !object(client) || Object.keys(client).sort().join(',') !== 'agent,clientId,token'
     || !text(client.token) || !text(client.clientId) || !object(client.agent) || !text(client.agent.id) || !text(client.agent.name)
     || Object.keys(client.agent).some(key => !['id', 'name', 'specialist'].includes(key))
     || client.agent.specialist !== c.surface.specialist || client.agent.id === c.agentId) throw new Error('Native fixture clients require a credential, clientId and distinct agent {id,name,specialist}.');
    c.clients.set(label, structuredClone(client));
    c.nativeAgents.add(client.agent.id);
   }
   c.fixtureValues = structuredClone(result.values ?? {});
   const setup = await auditRows(c, { agents: [...c.clients.values()].map(client => client.agent.id), includeFixtures: true });
   for (const row of setup.rows) if (!before.has(row.id)) {
    const client = [...c.clients.values()].find(client => client.agent.id === row.agent?.id);
    if (row.sponsor?.id !== c.sponsor.id || row.client_id !== client.clientId || row.agent?.name !== client.agent.name || row.agent?.specialist !== client.agent.specialist || row.consent !== null) throw new Error('Native fixture preparation identity differs from its declared client.');
    c.fixtureAuditIds.add(row.id);
   }
  } catch {
   c.clients.clear();
   throw new Error('Native phase preparation failed; fixture values are not logged.');
  }
 };
 c.stepTool = (step, args, options = {}) => c.tool(step.tool, args, { ...(step.client === undefined ? {} : { client: step.client }), ...options });
}
