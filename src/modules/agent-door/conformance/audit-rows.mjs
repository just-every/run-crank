/** Read each tested principal independently, retaining its native row order. */
export async function auditRows(c, { agents = [c.agentId, ...c.nativeAgents ?? []], includeFixtures = false } = {}) {
 const rows = []; let differs = 0;
 for (const agentId of new Set(agents)) {
  let cursor = null;
  for (let page = 0; ; page++) {
   if (page === 100) throw new Error('Audit pagination exceeded 100 pages');
   const query = new URLSearchParams();
   if (agentId !== null) query.set('agent', agentId);
   if (cursor) query.set('after', cursor);
   const result = await c.personJson(`/agents/api/audit?${query}`);
   if (!Array.isArray(result.rows) || !Number.isInteger(result.differs_from_policy)) throw new Error('Audit API must return rows and differs_from_policy');
   rows.push(...result.rows.filter(row => includeFixtures || !c.fixtureAuditIds?.has(row.id)));
   differs += result.differs_from_policy;
   if (result.cursor == null || result.cursor === cursor) break;
   cursor = result.cursor;
  }
 }
 return { rows, differs };
}
