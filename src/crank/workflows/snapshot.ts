import { APPS } from '../connections/apps'
import { getConnection } from '../connections/store'
import { canonical, digest, type CrankEnv } from '../model'

/** Versions retain the catalog/schema and account scope they were reviewed with;
 * dispatch still checks the live connection, and this snapshot grants no scopes. */
export async function snapshotBindings(env: CrankEnv, connectionIds: string[]) {
  const { CATALOG } = await import('../connections/catalog')
  return Promise.all(connectionIds.map(async connectionId => {
    const connection = await getConnection(env, connectionId)
    const schema = { connection: APPS[connection.app], operations: CATALOG.find(item => item.app === (connection.app === 'orbit' ? 'orbit' : connection.app === 'slack' ? 'slack' : 'webhooks')) }
    return { id: connectionId, app: connection.app, purpose: connection.purpose,
      scopes: JSON.parse(connection.scopes_json), schema, schema_digest: await digest(canonical(schema)) }
  }))
}
