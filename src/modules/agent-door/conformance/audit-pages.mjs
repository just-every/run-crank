export async function auditRows(c) {
 const rows = []; let cursor = null, differs = 0;
 for (let page = 0; page < 100; page++) {
  const result = await c.personJson(`/agents/api/audit?agent=${encodeURIComponent(c.agentId)}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
  if (!Array.isArray(result.rows) || !Number.isInteger(result.differs_from_policy)) throw new Error('Audit API must return rows and differs_from_policy');
  rows.push(...result.rows); differs += result.differs_from_policy;
  if (result.cursor == null || result.cursor === cursor) return { rows, differs };
  cursor = result.cursor;
 }
 throw new Error('Audit pagination exceeded 100 pages');
}
