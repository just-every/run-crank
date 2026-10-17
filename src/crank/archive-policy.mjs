// No credentials or sessions travel. Restored flows need fresh human activation;
// restored workflows arrive paused and their connections must be reconnected.
export default {
  product: 'automation/crank',
  excludeTables: ['crank_tokens', 'crank_authority_guards', 'crank_hooks', 'crank_oauth_apps', 'crank_oauth_states', 'crank_locks'],
  secretColumns: { crank_connections: ['secret_iv', 'secret_ciphertext'] },
  requiredConfiguration: ['OWNER_EMAIL','SESSION_SECRET','AUTH_ORIGIN','MAIL_PROVIDER','MAIL_FROM','CRANK_TARGET_ORIGIN','CRANK_TARGET_TOKEN'],
  exportRow(table,row) {
    if (table === 'crank_flows') return {...row,status:'draft'};
    if (table === 'crank_workflows') return {...row,status:row.status === 'draft' ? 'draft' : 'paused'};
    if (table === 'crank_connections') return {...row,status:row.status === 'revoked' ? 'revoked' : 'needs_reconnect'};
    return row;
  },
};
