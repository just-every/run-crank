import { fenceRow, validateRestore } from './restore-policy.mjs';

// Credentials, receiving authority and active execution never travel.
export default {
  product: 'automation/crank',
  includeTables: ['crank_erased_webhook_events'],
  excludeTables: ['crank_request_admissions', 'crank_tokens', 'crank_authority_guards', 'crank_hooks', 'crank_oauth_apps', 'crank_oauth_states', 'crank_locks', 'crank_log_sinks', 'crank_ops_events'],
  secretColumns: { crank_connections: ['secret_iv', 'secret_ciphertext'] },
  requiredConfiguration: ['OWNER_EMAIL','SESSION_SECRET','AUTH_ORIGIN','MAIL_PROVIDER','MAIL_FROM','CRANK_TARGET_ORIGIN','CRANK_TARGET_TOKEN'],
  exportRow: fenceRow,
  validateStaged: validateRestore,
};
