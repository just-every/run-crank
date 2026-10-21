import { fail, isObject } from './errors.mjs';
import { checkDestination } from './destinations.mjs';

const refused = () => fail('operation_refused', 'Task has no current exact connector, operation, environment and destination grant.');
export function authorizeTask(manifest, manifestPath, task, authority) {
  if (!isObject(authority) || authority.status !== 'active' || authority.expires_at <= Math.floor(Date.now() / 1000) ||
      !Array.isArray(authority.grants) || !isObject(task) ||
      task.installation !== authority.installation || task.environment !== authority.environment || task.gateway_id !== authority.gateway_id ||
      task.authority_revision !== authority.authority_revision || !Number.isSafeInteger(task.grant_revision) || task.grant_revision < 1 ||
      !Object.hasOwn(manifest.operations, task.operation)) refused();
  const op = manifest.operations[task.operation];
  if (task.connector_id !== op.connector_id || task.connector_version !== op.connector_version || task.destination !== op.destination ||
      typeof task.connector_operation !== 'string' || (op.connector_operation !== undefined && task.connector_operation !== op.connector_operation)) refused();
  const grant = authority.grants.find(item => isObject(item) && item.id === task.grant_id);
  if (!grant || grant.status !== 'active' || grant.revision !== task.grant_revision || grant.connector_id !== task.connector_id ||
      grant.connector_version !== task.connector_version || !Array.isArray(grant.operations) || !grant.operations.includes(task.connector_operation) ||
      !Array.isArray(grant.destinations)) refused();
  const destination = grant.destinations.find(item => isObject(item) && item.label === task.destination);
  if (!destination) refused();
  const { label, ...spec } = destination;
  if (op.destination_spec !== undefined) checkDestination(op, manifestPath, op.destination_spec);
  checkDestination(op, manifestPath, spec);
  return op;
}
