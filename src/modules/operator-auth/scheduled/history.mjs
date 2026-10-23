import { deny } from '../errors.mjs';
export const runColumns = 'id,policy_id AS policyId,version_hash AS versionHash,approval_id AS approvalId,approved_by AS approvedBy,started_at AS startedAt,finished_at AS finishedAt,status,error,repeats,COALESCE(last_seen_at,started_at) AS lastSeenAt';
export async function runHistory(store, request, fence) {
  const cursor = new URL(request.url).searchParams.get('before');
  if (cursor !== null && !/^[1-9][0-9]{0,15}$/.test(cursor)) deny('invalid_cursor', 400);
  const rows = (await store.statement(`SELECT rowid AS cursor,${runColumns} FROM oa_policy_runs WHERE ${fence.sql}
    ${cursor ? 'AND rowid<?' : ''} ORDER BY rowid DESC LIMIT 26`, [...fence.args, ...(cursor ? [Number(cursor)] : [])]).all()).results;
  const more = rows.length > 25;
  const runs = await Promise.all(rows.slice(0, 25).map(async ({ cursor: _, ...run }) => {
    const actions = (await store.statement(`SELECT id,actor_id AS actor,action,value,created_at AS createdAt FROM oa_auth_audit
      WHERE CASE WHEN json_valid(value) THEN json_extract(value,'$.runId') END=? AND ${fence.sql} ORDER BY rowid`, [run.id, ...fence.args]).all()).results
      .map(action => ({ ...action, value: JSON.parse(action.value) }));
    return { ...run, actions };
  }));
  return { runs, nextCursor: more ? String(rows[24].cursor) : null };
}
// Only identical, unadmitted ticks coalesce. Admitted runs retain their own actions.
export async function finishRun(store, id, error, now) {
  const status = error?.status ?? 'completed', code = error?.code ?? null;
  await store.batch([
    ["UPDATE oa_policy_runs SET status=?,error=?,finished_at=?,last_seen_at=? WHERE id=? AND status='running'", [status, code, now, now, id]],
    [`UPDATE oa_policy_runs SET repeats=repeats+1,last_seen_at=? WHERE rowid=(
      SELECT prior.rowid FROM oa_policy_runs prior JOIN oa_policy_runs tick ON tick.id=?
      WHERE tick.admitted=0 AND tick.status='refused' AND prior.rowid=(SELECT MAX(rowid) FROM oa_policy_runs WHERE rowid<tick.rowid AND policy_id=tick.policy_id)
      AND prior.admitted=0 AND prior.policy_id=tick.policy_id AND prior.version_hash IS tick.version_hash
      AND prior.approval_id IS tick.approval_id AND prior.status=tick.status AND prior.error IS tick.error)
      `, [now, id]],
    ['DELETE FROM oa_policy_runs WHERE id=? AND changes()>0', [id]],
  ]);
}
