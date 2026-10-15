// No credentials or sessions travel. Restored flows need fresh human activation.
export default {
  product: 'automation/crank',
  excludeTables: ['crank_tokens', 'crank_authority_guards'],
  requiredConfiguration: ['OWNER_EMAIL','SESSION_SECRET','AUTH_ORIGIN','MAIL_PROVIDER','MAIL_FROM','CRANK_TARGET_ORIGIN','CRANK_TARGET_TOKEN'],
  exportRow(table,row) { return table === 'crank_flows' ? {...row,status:'draft'} : row; },
};
