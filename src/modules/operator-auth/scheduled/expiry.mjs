// Cloudflare's scheduled-handler wall-clock limit:
// https://developers.cloudflare.com/workers/platform/limits/#duration
export const scheduledHandlerLimitMs = 15 * 60000;

export async function expireRuns(store, policyId, now) {
  const stale = "policy_id=? AND status='running' AND started_at<?";
  const args = [policyId, now - scheduledHandlerLimitMs];
  // One transaction records each abandoned run exactly once before closing it.
  await store.batch([
    [`INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at)
      SELECT lower(hex(randomblob(16))),'policy:'||policy_id||CASE WHEN version_hash IS NULL THEN '' ELSE '@'||version_hash END,'policy:expired',
        json_object('policyId',policy_id,'versionHash',version_hash,'approvalId',approval_id,
          'approvedBy',approved_by,'runId',id,'error','policy_expired'),?
      FROM oa_policy_runs WHERE ${stale}`, [now, ...args]],
    [`UPDATE oa_policy_runs SET status='failed',error='policy_expired',finished_at=?,last_seen_at=? WHERE ${stale}`, [now, now, ...args]],
  ]);
}
