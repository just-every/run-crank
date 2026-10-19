import { guardedBatch, requireOwner } from '../access'
import { now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from './audit'

/** DATA-003 data classes. Financial and health need the owner's recorded attestation before
 * production processing; Crank records it as owner-attested and never verifies or certifies it. */
export const DATA_CLASSES = ['none', 'customer', 'financial', 'health'] as const
export const ATTESTED_CLASSES = ['financial', 'health']
export const ATTESTATION_LABEL = 'Owner-attested. Crank has not verified or certified these agreements or this location.'

export async function sensitiveData(env: CrankEnv) {
  const [attestations, workflows] = await Promise.all([
    stmt(env, 'SELECT * FROM crank_data_attestations ORDER BY data_class').all<{ data_class: string; agreements_json: string; data_location: string; attested_by: string; attested_at: string }>(),
    stmt(env, "SELECT id,name,status,data_class FROM crank_workflows WHERE data_class!='none' ORDER BY name,id").all(),
  ])
  return { label: ATTESTATION_LABEL, attestations: attestations.results.map(({ agreements_json, ...a }) => ({ ...a, agreements: JSON.parse(agreements_json), basis: 'owner_attested' })), workflows: workflows.results }
}

/** Refuses publishing or resuming a financial or health workflow without its class's attestation. */
export async function requireAttested(env: CrankEnv, workflowId: string) {
  const row = await stmt(env, 'SELECT w.data_class,a.data_class AS attested FROM crank_workflows w LEFT JOIN crank_data_attestations a ON a.data_class=w.data_class WHERE w.id=?', workflowId).first<{ data_class: string; attested: string | null }>()
  requireValue(!row || !ATTESTED_CLASSES.includes(row.data_class) || row.attested, `This workflow processes ${row?.data_class} data. Record your attestation of the provider agreements and data location on the Data screen first.`, 409)
}
/** The same condition inside the publish or resume batch, so a revocation in between wins. */
export const attestedGuard = (env: CrankEnv, guard: string, workflowId: string) => stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_workflows w
  WHERE w.id=? AND (w.data_class NOT IN ('financial','health') OR EXISTS(SELECT 1 FROM crank_data_attestations a WHERE a.data_class=w.data_class))) THEN 1 ELSE 0 END`, guard, workflowId)

export async function setDataClass(env: CrankEnv, actor: Actor, workflowId: string, value: unknown) {
  requireOwner(actor)
  requireValue(typeof value === 'string' && (DATA_CLASSES as readonly string[]).includes(value), 'Choose none, customer, financial or health')
  const workflow = await stmt(env, 'SELECT id,status,data_class FROM crank_workflows WHERE id=?', workflowId).first<{ id: string; status: string; data_class: string }>()
  requireValue(workflow, 'Workflow not found', 404)
  if (workflow.status === 'published' && ATTESTED_CLASSES.includes(value)) requireValue(await stmt(env, 'SELECT 1 FROM crank_data_attestations WHERE data_class=?', value).first(), `Record your ${value} data attestation first, or pause this workflow before classifying it.`, 409)
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'UPDATE crank_workflows SET data_class=? WHERE id=?', value, workflowId),
    auditStatement(env, actor.id, 'workflow.data_class', 'workflow', workflowId, { from: workflow.data_class, to: value }),
  ])
  return { id: workflowId, data_class: value }
}

/** Agreements are free text the owner names (for example "Cloudflare BAA, signed 2026-09-01"). */
export async function attest(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  requireValue(typeof input.data_class === 'string' && ATTESTED_CLASSES.includes(input.data_class), 'Attest for financial or health data')
  requireValue(input.confirm === 'ATTEST', 'Type ATTEST to record that these agreements are in place')
  const agreements = (Array.isArray(input.agreements) ? input.agreements : String(input.agreements ?? '').split('\n')).map(a => String(a).trim()).filter(Boolean)
  requireValue(agreements.length >= 1 && agreements.length <= 20, 'Name each provider agreement in place (1 to 20)')
  const named = agreements.map(a => text(a, 'Agreement', 300)), location = text(input.data_location, 'Data location', 300), at = now()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'INSERT INTO crank_data_attestations(data_class,agreements_json,data_location,attested_by,attested_at) VALUES(?,?,?,?,?) ON CONFLICT(data_class) DO UPDATE SET agreements_json=excluded.agreements_json,data_location=excluded.data_location,attested_by=excluded.attested_by,attested_at=excluded.attested_at', input.data_class, JSON.stringify(named), location, actor.id, at),
    auditStatement(env, actor.id, 'data.attest', 'data_class', input.data_class, { agreements: named, data_location: location, basis: 'owner_attested' }),
  ])
  return (await sensitiveData(env)).attestations.find(a => a.data_class === input.data_class)
}
/** Withdrawing an attestation pauses every published workflow of that class at once. */
export async function revokeAttestation(env: CrankEnv, actor: Actor, dataClass: string) {
  requireOwner(actor)
  requireValue(await stmt(env, 'SELECT 1 FROM crank_data_attestations WHERE data_class=?', dataClass).first(), 'No attestation recorded for this data class', 404)
  const paused = (await stmt(env, "SELECT id FROM crank_workflows WHERE data_class=? AND status='published'", dataClass).all<{ id: string }>()).results
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'DELETE FROM crank_data_attestations WHERE data_class=?', dataClass),
    stmt(env, "UPDATE crank_workflows SET status='paused' WHERE data_class=? AND status='published'", dataClass),
    auditStatement(env, actor.id, 'data.attest_revoke', 'data_class', dataClass, { paused: paused.map(w => w.id) }),
  ])
  return { data_class: dataClass, paused: paused.map(w => w.id) }
}
