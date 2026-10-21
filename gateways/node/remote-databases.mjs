import { GatewayError } from './errors.mjs';
import { validateRemoteDatabase, validateRemoteInput, databaseFailure } from './remote-databases-policy.mjs';
import { postgresQuery, mysqlQuery } from './remote-databases-pg-mysql.mjs';
import { sqlserverQuery } from './remote-databases-sqlserver.mjs';

export { validateRemoteDatabase } from './remote-databases-policy.mjs';

// Driver imports occur inside the selected adapter. SQLite/file users do not
// install or load any remote database driver or SQL parser.
export async function executeRemoteDatabase(op, input) {
  validateRemoteDatabase(op);
  validateRemoteInput(op, input);
  try {
    if (op.type === 'postgres-query') return await postgresQuery(op, input);
    if (op.type === 'mysql-query') return await mysqlQuery(op, input);
    return await sqlserverQuery(op, input);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
      throw new GatewayError('execution_failed', 'Install the private gateway package dependencies before using remote databases.');
    }
    throw databaseFailure(error);
  }
}
