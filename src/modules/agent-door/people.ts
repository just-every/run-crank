import type { Person, PeopleAdapter, PreparedBy, Principal, Runtime } from './types.ts'
export const businessRole = (people: PeopleAdapter, person: Person) => people.businessRole ? people.businessRole(person) : person.role === 'owner' ? 'owner' : person.role === 'admin' ? 'editor' : null
export const preparedBy = ({ person, agent }: Pick<Principal, 'person' | 'agent'>): PreparedBy => ({ agent: { id: agent.id, name: agent.name }, for: { id: person.id, name: person.name }, label: `${agent.name} for ${person.name}` })
export async function matchesRef(rt: Runtime, person: Person, sponsor: string, ref: string): Promise<boolean> {
  if (!person.active) return false
  if (ref === 'sponsor') return person.id === sponsor
  if (rt.options.trust) {
    const member = await rt.options.people.businessMember?.(person)
    return !!member && (ref.startsWith('person:') ? member.id === ref.slice(7) : member.role !== null && ref === `role:${member.role}`)
  }
  return ref.startsWith('person:') ? person.id === ref.slice(7) : ref === `role:${businessRole(rt.options.people, person)}`
}
export async function matchingRefs(rt: Runtime, person: Person, sponsor: string, refs: string[]) {
  return (await Promise.all(refs.map(async ref => await matchesRef(rt, person, sponsor, ref) ? ref : null))).filter((ref): ref is string => ref !== null)
}
