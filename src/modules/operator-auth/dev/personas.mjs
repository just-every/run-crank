import { DEFAULT_ROLES } from '../accounts/roles.mjs';

// A seed's devPersonas() returns [{ as, role, displayName? }]. Each persona is
// a real operator at `<as>@dev.localhost`, created only by local dev sign-in.
// Export marks them suspended; `.localhost` mail never leaves this computer.
export const PERSONA_DOMAIN = 'dev.localhost';
export function definePersonas(list) {
  if (!Array.isArray(list)) throw new TypeError('devPersonas() must return an array.');
  const seen = new Set(['owner', 'signed-out']);
  return Object.freeze(list.map(entry => {
    const { as, role, displayName } = entry ?? {};
    if (typeof as !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(as) || seen.has(as)) throw new TypeError(`Invalid or repeated dev persona name: ${String(as)}`);
    if (!DEFAULT_ROLES.includes(role)) throw new TypeError(`Dev persona ${as} needs a role: ${DEFAULT_ROLES.join(', ')}.`);
    seen.add(as);
    return Object.freeze({ as, role, email: `${as}@${PERSONA_DOMAIN}`, displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 80) : `Dev ${as}` });
  }));
}
