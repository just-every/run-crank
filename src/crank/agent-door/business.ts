import { createBusinessSettings } from '../../modules/business-settings/index.ts'
import { operatorAuth, type Bindings } from '../../auth.server'

/** Signed settings establish durable Business subject -> native person bindings. */
export function businessSettings(env: Bindings) {
  return createBusinessSettings({
    db: env.DB, trust: env.RER_BUSINESS_TRUST,
    business: { settings: 1, values: ['display_name'], team: { roles: { admin: 'admin', member: 'member' } } },
    team: operatorAuth(env).businessTeam,
  })
}
