import { errorCode } from './protocol.mjs';

// Refresh read dependencies only. Repeating a write here would create another
// effect, and resolving its old output cannot provide a current native revision.
export async function injectionArgs(c, step, outputs, admittedArgs) {
 const fresh = new Map(outputs), refreshed = new Set();
 async function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$from === 'string') {
   const source = c.surface.journey.find(item => item.id === value.$from);
   if (!source || refreshed.has(source.id) || !c.surface.tools.find(tool => tool.name === source.tool)?.readOnly) return;
   refreshed.add(source.id);
   await visit(source.args);
   const args = c.args(source, fresh), proof = await c.proof(source.tool, args);
   const answer = await c.tool(source.tool, args, proof);
   if (answer.result?.isError || answer.result?.structuredContent === undefined) throw new Error(`Injection prerequisite ${source.id} failed (${errorCode(answer) ?? answer.status})`);
   fresh.set(source.id, answer.result.structuredContent);
  } else for (const item of Object.values(value)) await visit(item);
 }
 await visit(step.args);
 const write = !c.surface.tools.find(tool => tool.name === step.tool)?.readOnly;
 // A mutation keeps its admitted arguments, including revision and key. Fresh
 // read dependencies must not turn its injection probe into a different call.
 const args = write ? admittedArgs : c.resolve(step.args, fresh);
 return { ...args, ...c.resolve(step.inject, fresh), ...(write ? { idempotency_key: admittedArgs.idempotency_key } : {}) };
}
