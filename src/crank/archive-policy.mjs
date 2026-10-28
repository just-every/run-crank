import { fenceRow, importRow, importSafety, validateRestore } from './restore-policy.mjs';

// Email aliases travel inactive; value-free receipts and sealed run files retain custody.
// AI classifications retain validated outputs, model provenance and bounded response
// checkpoints in the existing step, attempt and usage inventory, without model keys.
// App subject indexes, pending-row digests, field-value digests and erased-record fences use the default portable
// inventory. Polls restore inactive; no receiving authority travels with history.
// Digest definitions, entries, release receipts and erased-name fences use the
// default portable inventory; the restore policy clears their receiving authority.
// Credentials, data-class keys (DATA-003: an archive carries sealed values and blind-index
// digests only), receiving authority and active execution never travel; older
// archives are normalized to the same inactive state on import (DATA-001).
export default {
  product: 'automation/crank',
  includeTables: ['crank_erased_webhook_events'],
  excludeTables: ['crank_custom_search_keys', 'crank_sample_listeners', 'crank_team_migration_reports', 'crank_recurring_claims', 'crank_mcp_clients', 'crank_mcp_calls', 'crank_oauth_refresh_leases', 'crank_notice_routes', 'crank_installation_signing', 'crank_gateway_nonces', 'crank_team_authority', 'crank_service_accounts', 'crank_gateway_tasks', 'crank_custom_hook_checks', 'crank_agent_followup_people', 'crank_agent_followup_authorizations', 'crank_agent_followup_admissions', 'crank_team_access', 'crank_workflow_idempotency', 'crank_task_idempotency', 'crank_grants', 'crank_grant_admissions', 'crank_request_admissions', 'crank_tokens', 'crank_authority_guards', 'crank_hooks', 'crank_oauth_apps', 'crank_oauth_states', 'crank_locks', 'crank_log_sinks', 'crank_ops_events', 'ik_door_settings', 'ik_door_revoked_keys', 'ik_door_grants', 'crank_payload_keys'],
  secretColumns: { crank_gateways:['code_hash','code_expires_at','credential_hash','public_key','fingerprint'], crank_connections: ['secret_iv', 'secret_ciphertext'] },
  requiredConfiguration: ['OWNER_EMAIL','SESSION_SECRET','AUTH_ORIGIN','MAIL_PROVIDER','MAIL_FROM','CRANK_TARGET_ORIGIN','CRANK_TARGET_TOKEN'],
  exportRow: fenceRow,
  importSafety,
  importRow,
  validateStaged: validateRestore,
};
