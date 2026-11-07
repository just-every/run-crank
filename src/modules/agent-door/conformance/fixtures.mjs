import { auditRows } from './audit-rows.mjs';
import { seconds } from './crypto.mjs';

export class FixtureDatabaseError extends Error {
 constructor() {
  super('agent_fixtures_database_unavailable: Disposable database access refused; fixture values, records and SQL are not logged.');
  this.code = 'agent_fixtures_database_unavailable';
 }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Each round gets new native state, never a previous round's consumed values. */
export function phaseFixtures(c, prepare) {
 c.fixtureValues = {};
 c.fixtureSponsors = {};
 c.clients = new Map();
 c.nativeAgents = new Set();
 c.fixtureAuditIds = new Set();
 c.prepare = async phase => {
  c.fixtureValues = {};
  c.fixtureSponsors = {};
  c.clients.clear();
  if (!prepare) return;
  try {
   const before = new Set((await auditRows(c, { agents: [null], includeFixtures: true })).rows.map(row => row.id));
   const result = await prepare({ phase, tool: c.tool, now: seconds(c.now) * 1000 });
   if (!object(result) || Object.keys(result).some(key => !['values', 'clients', 'sponsors'].includes(key)) || !object(result.values ?? {}) || !object(result.clients ?? {}) || !object(result.sponsors ?? {})) throw new Error('Native phase preparation must return {values,clients,sponsors}.');
   for (const [kind, sponsor] of Object.entries(result.sponsors ?? {})) {
    if (!['inactive', 'excluded'].includes(kind) || !object(sponsor) || Object.keys(sponsor).sort().join(',') !== 'email,sub'
     || !text(sponsor.sub) || !text(sponsor.email) || sponsor.email !== sponsor.email.trim().toLowerCase()
     || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(sponsor.email)) throw new Error('Native fixture sponsors require a subject and canonical email for an inactive or excluded person.');
   }
   for (const [label, client] of Object.entries(result.clients ?? {})) {
    if (!text(label) || !object(client) || Object.keys(client).sort().join(',') !== 'agent,clientId,token'
     || !text(client.token) || !text(client.clientId) || !object(client.agent) || !text(client.agent.id) || !text(client.agent.name)
     || Object.keys(client.agent).some(key => !['id', 'name', 'specialist'].includes(key))
     || client.agent.specialist !== c.surface.specialist || client.agent.id === c.agentId) throw new Error('Native fixture clients require a credential, clientId and distinct agent {id,name,specialist}.');
    c.clients.set(label, structuredClone(client));
    c.nativeAgents.add(client.agent.id);
   }
   c.fixtureValues = structuredClone(result.values ?? {});
   c.fixtureSponsors = structuredClone(result.sponsors ?? {});
   const setup = await auditRows(c, { agents: [...c.clients.values()].map(client => client.agent.id), includeFixtures: true });
   for (const row of setup.rows) if (!before.has(row.id)) {
    const client = [...c.clients.values()].find(client => client.agent.id === row.agent?.id);
    if (row.sponsor?.id !== c.sponsor.id || row.client_id !== client.clientId || row.agent?.name !== client.agent.name || row.agent?.specialist !== client.agent.specialist || row.consent !== null) throw new Error('Native fixture preparation identity differs from its declared client.');
    c.fixtureAuditIds.add(row.id);
   }
  } catch (error) {
   c.clients.clear();
   c.fixtureValues = {};
   c.fixtureSponsors = {};
   if (error instanceof FixtureDatabaseError) throw error;
   throw new Error('Native phase preparation failed; fixture values are not logged.');
  }
 };
 c.stepTool = (step, args, options = {}) => c.tool(step.tool, args, { ...(step.client === undefined ? {} : { client: step.client }), ...options });
}
