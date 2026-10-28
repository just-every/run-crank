import type { Principal, Runtime } from './types.ts'

/** Persist identity and atomically count capacity before any tool admission. */
export async function admit(rt: Runtime, principal: Principal): Promise<'revoked' | number | null> {
  const db = rt.options.db, window = Math.floor(rt.now() / 60000)
  const agent = await db.prepare(`INSERT INTO agent_door_agents(id,name,specialist,sponsor,sponsor_name,window,requests)
    VALUES(?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name,specialist=excluded.specialist,sponsor_name=excluded.sponsor_name
    WHERE agent_door_agents.sponsor=excluded.sponsor AND agent_door_agents.revoked=0 RETURNING revoked,sponsor`).bind(principal.agent.id, principal.agent.name,
    principal.agent.specialist ?? null, principal.person.id, principal.person.name, window).first<{ revoked: number; sponsor: string }>()
  if (!agent || agent.revoked || agent.sponsor !== principal.person.id) return 'revoked'
  const counted = await db.prepare(`UPDATE agent_door_agents SET requests=CASE WHEN window=? THEN requests+1 ELSE 1 END,window=?
    WHERE id=? AND revoked=0 AND (window<>? OR requests<?) RETURNING requests`)
    .bind(window, window, principal.agent.id, window, rt.options.limits?.requestsPerMinute ?? 600).first()
  return counted ? null : Math.max(1, Math.ceil(((window + 1) * 60000 - rt.now()) / 1000))
}
