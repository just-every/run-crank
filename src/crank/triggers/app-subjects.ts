import { createErasure, defineErasure, type PortabilityFence } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import { guardedBatch } from '../access'
import { canonical, digest, id, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { HELD_WORKFLOW_RUN } from '../legal-holds'
import { auditStatement } from '../ops/audit'
import { identifierValues, SEALED_PREFIX, openText } from '../ops/payload-seal'

type Identity = { workflow_id: string; record_id: string }
export interface AppSubjectRecord extends Identity { blocked: string | null }
interface RetainedRecord { row: Identity; subjectDigest: string; texts: string[]; identifiers: Set<string> }
interface AppSubjectState {
  subjects: [string, string, string][]
  snapshots: [string, string, string, string, string, string | null][]
  values: [string, string, string, string, string][]
  pending: [string, string, string, string, string][]
  workflows: [string, string, string, string][]
  holds: [string, string, string | null, string | null, string | null, string | null][]
  runs: [string, string, string, string, number][]
}
const terminal = ['succeeded', 'failed', 'stopped_by_filter', 'stopped_by_search', 'cancelled', 'rejected']
const identity = (row: Identity) => canonical([row.workflow_id, row.record_id])
const appWorkflows = `SELECT workflow_id FROM crank_app_subjects UNION SELECT workflow_id FROM crank_app_snapshots
  UNION SELECT workflow_id FROM crank_app_field_values UNION SELECT workflow_id FROM crank_app_pending_rows`
const array = (columns: string, source: string, order: string) => `(SELECT json_group_array(json_array(${columns})) FROM (SELECT * FROM ${source} ORDER BY ${order}))`
// The same ordered read is compared inside the erasure transaction. Raw values remain
// request-local; the public preview contains only its digest and opaque record keys.
const STATE_SQL = `SELECT json_object(
  'subjects',json(${array('workflow_id,record_id,record_subject_digest', 'crank_app_subjects', 'workflow_id,record_id')}),
  'snapshots',json(${array('workflow_id,version_id,record_id,fields_json,changed_at,observed_at', 'crank_app_snapshots', 'workflow_id,version_id,record_id')}),
  'values',json(${array('workflow_id,record_id,field,value_digest,first_seen_at', 'crank_app_field_values', 'workflow_id,record_id,field,value_digest')}),
  'pending',json(${array('workflow_id,version_id,record_id,value_digest,stable_since', 'crank_app_pending_rows', 'workflow_id,version_id,record_id')}),
  'workflows',json(${array('id,status,data_class,identifier_fields_json', `(SELECT * FROM crank_workflows WHERE id IN (${appWorkflows}))`, 'id')}),
  'holds',json(${array('id,kind,subject,subject_encoded,subject_digest,workflow_id', '(SELECT * FROM crank_legal_holds WHERE released_at IS NULL)', 'id')}),
  'runs',json((SELECT json_group_array(json_array(id,workflow_id,business_key,status,held)) FROM (
    SELECT r.id,r.workflow_id,r.business_key,r.status,CASE WHEN ${HELD_WORKFLOW_RUN} THEN 1 ELSE 0 END AS held
    FROM crank_wf_runs r WHERE r.trigger_kind='app_poll' ORDER BY r.id)))
) AS value`

/** Observe every source record, including seeds, nonmatches and settling rows. */
export async function appSubjectWriter(env: CrankEnv, workflowId: string, recordId: string, recordKey: string) {
  const subject = await digest(recordId.trim().toLowerCase())
  return (guard = '1', params: unknown[] = []) => stmt(env, `INSERT INTO crank_app_subjects(workflow_id,record_id,record_subject_digest) SELECT ?,?,? WHERE ${guard}
    ON CONFLICT(workflow_id,record_id) DO NOTHING`, workflowId, recordKey, subject, ...params)
}

/** Retained app records have a life before admission; DATA-002 covers that life too. */
export async function previewAppSubjects(env: CrankEnv, value: string) {
  const raw = (await stmt(env, STATE_SQL).first<{ value: string }>())!.value
  const state = JSON.parse(raw) as AppSubjectState, subjectDigest = await digest(value)
  const workflows = new Map(state.workflows.map(([workflow, status, , fields]) => [workflow, { status, fields: JSON.parse(fields) as string[] }]))
  const records = new Map<string, RetainedRecord>()
  for (const [workflow_id, record_id, marker] of state.subjects) {
    const row = { workflow_id, record_id }
    records.set(identity(row), { row, subjectDigest: marker, texts: [], identifiers: new Set() })
  }
  const unindexed = new Set<string>(), unavailable = new Set<string>()
  for (const [workflow_id, , record_id, text] of state.snapshots) {
    const key = identity({ workflow_id, record_id }), record = records.get(key)
    if (!record) unindexed.add(key)
    if (text.startsWith(SEALED_PREFIX)) {
      try {
        const opened = await openText(env, workflow_id, text, 'strict')
        if (record) identifierValues(JSON.parse(opened!), workflows.get(workflow_id)!.fields, record.identifiers)
      } catch { unavailable.add(key) }
    } else if (record) record.texts.push(text.toLowerCase())
  }
  for (const [workflow_id, record_id] of state.values) if (!records.has(identity({ workflow_id, record_id }))) unindexed.add(identity({ workflow_id, record_id }))
  for (const [workflow_id, , record_id] of state.pending) if (!records.has(identity({ workflow_id, record_id }))) unindexed.add(identity({ workflow_id, record_id }))
  const matches = (record: RetainedRecord, subject: string, encoded: string, marker: string) =>
    record.subjectDigest === marker || record.identifiers.has(subject) || record.texts.some(text => text.includes(encoded))
  const app_records: AppSubjectRecord[] = []
  for (const record of records.values()) {
    if (!matches(record, value, JSON.stringify(value).slice(1, -1), subjectDigest)) continue
    const held = state.holds.some(([, kind, subject, encoded, marker, workflow]) => kind === 'workflow' ? workflow === record.row.workflow_id
      : matches(record, subject!, encoded!, marker!))
    const runs = state.runs.filter(([, workflow, key]) => workflow === record.row.workflow_id && key === record.row.record_id)
    app_records.push({ ...record.row, blocked: held || runs.some(([, , , , held]) => held) ? 'Under a legal hold: release it first.'
      : runs.some(([, , , status]) => !terminal.includes(status)) ? 'Finish or cancel this record’s runs first.'
      : workflows.get(record.row.workflow_id)?.status !== 'paused' ? 'Pause its workflow first.' : null })
  }
  const unmatched = [
    ...(unindexed.size ? [`${unindexed.size} retained app record${unindexed.size === 1 ? ' has' : 's have'} no case-insensitive identifier index. Poll the source again to observe those records before erasing a subject.`] : []),
    ...(unavailable.size ? [`${unavailable.size} encrypted app record${unavailable.size === 1 ? ' is' : 's are'} sealed under a key this installation does not hold. Import the owner's key file on the Data screen before erasing a subject.`] : []),
  ]
  return { app_records, unmatched, state_digest: await digest(raw), raw }
}

/** Base fences each snapshot version and each comparison/pending/index row. The
 * permanent record fence also catches a poll prepared before the owner erased it. */
export async function eraseAppSubjects(env: CrankEnv, actor: Actor, portability: PortabilityFence, value: string, expected: string) {
  const preview = await previewAppSubjects(env, value)
  requireValue(preview.state_digest === expected, 'The retained app records changed since the preview. Preview again.', 409)
  requireValue(!preview.unmatched.length, preview.unmatched.join(' '), 409)
  requireValue(!preview.app_records.some(record => record.blocked), 'Pause the matching workflows and release legal holds before erasing app records.', 409)
  if (!preview.app_records.length) return []
  const service = createErasure({ db: env.DB, portability, declarations: [defineErasure({
    entity: 'app-subject', root: { table: 'crank_app_subjects' },
    edges: ['crank_app_snapshots', 'crank_app_field_values', 'crank_app_pending_rows'].map(table => ({ table, from: 'crank_app_subjects', on: { workflow_id: 'workflow_id', record_id: 'record_id' } })),
    retain: [{ table: 'crank_app_erased_records', reason: 'Opaque workflow and record keys permanently prevent source redelivery from restoring an erased record.' }],
    beforeStatements: ({ subject }) => [stmt(env, 'INSERT OR IGNORE INTO crank_app_erased_records(workflow_id,record_id) VALUES(?,?)', subject.workflow_id, subject.record_id)],
  })] })
  const prepared = []
  for (const record of preview.app_records) prepared.push(await service.nativeStatements('app-subject', { workflow_id: record.workflow_id, record_id: record.record_id }))
  const guard = `erase-app-subject:${id()}`
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN (${STATE_SQL})=? THEN 1 ELSE 0 END`, guard, preview.raw),
    ...prepared.flatMap(operation => operation.statements.map(statement => stmt(env, statement.sql, ...statement.params))),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    ...prepared.map(operation => auditStatement(env, actor.id, 'data.erase', 'erasure', operation.operationId, { entity: 'app-subject' })),
  ])
  const operations = []
  for (const operation of prepared) operations.push((await service.deleteBlobs(operation.operationId)).id)
  return operations
}
