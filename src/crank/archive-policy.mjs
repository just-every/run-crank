import { fenceRow, importRow, importSafety, validateRestore } from './restore-policy.mjs';

// Credentials, data-class keys (DATA-003: an archive carries sealed values and blind-index
// digests only), receiving authority and active execution never travel; older
// archives are normalized to the same inactive state on import (DATA-001).
export default {
  product: 'automation/crank',
  includeTables: ['crank_erased_webhook_events'],
  excludeTables: ['crank_workflow_idempotency', 'crank_grants', 'crank_grant_admissions', 'crank_request_admissions', 'crank_tokens', 'crank_authority_guards', 'crank_hooks', 'crank_oauth_apps', 'crank_oauth_states', 'crank_locks', 'crank_log_sinks', 'crank_ops_events', 'ik_door_settings', 'ik_door_revoked_keys', 'ik_door_grants', 'crank_payload_keys'],
  secretColumns: { crank_connections: ['secret_iv', 'secret_ciphertext'] },
  requiredConfiguration: ['OWNER_EMAIL','SESSION_SECRET','AUTH_ORIGIN','MAIL_PROVIDER','MAIL_FROM','CRANK_TARGET_ORIGIN','CRANK_TARGET_TOKEN'],
  exportRow: fenceRow,
  importSafety,
  importRow,
  validateStaged: validateRestore,
};
