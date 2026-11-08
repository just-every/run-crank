import type { PeopleAdapter, Person } from './types.ts'
import { isActiveOperator, type Operator as NativeOperator } from '../operator-auth/index.mjs'

interface Operator { id: string; email: string; displayName: string; role: string; status: string }
/** Business subjects bind through settings; native ids survive changes of address. */
export function operatorAuthPeople(options: { db: D1Database; allowList?: string[]; session(request: Request): Promise<{ operator: Operator } | null> }): PeopleAdapter {
  const person = (operator: Operator): Person => ({ id: operator.id, email: operator.email, name: operator.displayName, role: operator.role, active: isActiveOperator(operator as NativeOperator, options.allowList) })
  const read = async (id: string) => {
    const operator = await options.db.prepare('SELECT id,email,display_name AS displayName,role,status FROM oa_operators WHERE id=?').bind(id).first<Operator>()
    return operator ? person(operator) : null
  }
  const owner = () => options.db.prepare(`SELECT o.id FROM oa_operators o LEFT JOIN oa_bootstrap b ON b.claim_id=o.id
    WHERE o.role='owner' ORDER BY b.claim_id IS NULL,o.created_at,o.id LIMIT 1`).first<{ id: string }>()
  const ownerId = async () => (await options.db.prepare('SELECT owner_id FROM bs_settings WHERE singleton=1').first<{ owner_id: string | null }>())?.owner_id ?? null
  const stopped = async () => !!await options.db.prepare('SELECT 1 FROM bs_settings WHERE singleton=1 AND stopped=1').first()
  return {
    person: read,
    businessStopped: stopped,
    // The subject mapping outlives a stop, so signed policy naming Business people is still adopted and Pause applies.
    // The door, not this mapping, ends Business admission and Business refs (businessStopped).
    async sponsor({ sub }) {
      if (await ownerId() === sub) {
        const installationOwner = await owner()
        return installationOwner ? read(installationOwner.id) : null
      }
      const row = await options.db.prepare("SELECT operator_id FROM bs_team WHERE business_id=? AND state<>'conflict'").bind(sub).first<{ operator_id: string | null }>()
      return row?.operator_id ? read(row.operator_id) : null
    },
    async businessMember(person) {
      if (await stopped()) return null
      const id = await ownerId()
      if (id && (await owner())?.id === person.id) return { id, role: 'owner' }
      const row = await options.db.prepare("SELECT business_id,business_role FROM bs_team WHERE operator_id=? AND state<>'conflict' AND business_id IS NOT NULL").bind(person.id).first<{ business_id: string; business_role: string }>()
      return row ? { id: row.business_id, role: row.business_role === 'admin' ? 'editor' : null } : null
    },
    async session(request) {
      const session = await options.session(request)
      if (!session) return null
      const current = await read(session.operator.id)
      return current?.active ? current : null
    },
  }
}

/** Native operator subjects only. The installation/Business owner follows the owner role. */
export async function operatorPolicyRefs(db: D1Database, operatorId: string): Promise<string[]> {
  const rows = (await db.prepare('SELECT business_id FROM bs_team WHERE operator_id=? AND business_id IS NOT NULL AND business_id NOT IN (SELECT owner_id FROM bs_settings WHERE singleton=1 AND owner_id IS NOT NULL)').bind(operatorId).all<{ business_id: string }>()).results
  return [...new Set(['person:' + operatorId, ...rows.map(row => 'person:' + row.business_id)])]
}
