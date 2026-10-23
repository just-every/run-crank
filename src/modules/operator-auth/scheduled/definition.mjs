import { AuthError } from '../errors.mjs';
const actions = ['operators:deactivate', 'operators:reactivate'];
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
function invalid() { throw new AuthError('invalid_policy', 503); }
function keys(value, allowed) { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(); }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + Array.from(value, canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return invalid();
}
export async function policyVersion(input) {
  const json = canonical(input);
  if (json.length > 32768) invalid();
  input = JSON.parse(json);
  keys(input, ['id', 'kind', 'parameters', 'actions', 'maxActionsPerRun', 'minIntervalMinutes']);
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(input.id) || typeof input.id !== 'string' || typeof input.kind !== 'string' || !/^[a-z][a-z0-9:._-]{0,119}$/.test(input.kind) || !plain(input.parameters) || !Array.isArray(input.actions) || !input.actions.length || input.actions.length > 20) invalid();
  if (!Number.isSafeInteger(input.maxActionsPerRun) || input.maxActionsPerRun < 1 || input.maxActionsPerRun > 100 || !Number.isSafeInteger(input.minIntervalMinutes) || input.minIntervalMinutes < 1 || input.minIntervalMinutes > 525600) invalid();
  for (const grant of input.actions) {
    keys(grant, ['action', 'scope']);
    if (!actions.includes(grant.action)) invalid();
    keys(grant.scope, ['roles', 'operatorIds', 'inactiveDays']);
    const { roles, operatorIds, inactiveDays } = grant.scope;
    if (!Array.isArray(roles) || !roles.length || roles.some(role => !['member', 'admin'].includes(role)) || new Set(roles).size !== roles.length) invalid();
    if (operatorIds !== undefined && (!Array.isArray(operatorIds) || !operatorIds.length || operatorIds.length > 500 || operatorIds.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(operatorIds).size !== operatorIds.length)) invalid();
    if (inactiveDays !== undefined && (!Number.isSafeInteger(inactiveDays) || inactiveDays < 1 || inactiveDays > 36500)) invalid();
  }
  const versionHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { definition: input, versionHash, json, actionsJson: canonical(input.actions) };
}
export async function readPolicy(definitions, id) {
  const policies = definitions();
  if (!Array.isArray(policies) || new Set(policies.map(policy => policy.id)).size !== policies.length) invalid();
  const input = policies.find(policy => policy.id === id);
  if (!input) throw new AuthError('policy_not_found', 404);
  const policy = await policyVersion(input);
  if (policy.definition.id !== id) invalid();
  return policy;
}
