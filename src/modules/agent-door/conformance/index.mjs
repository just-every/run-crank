import { randomUUID } from 'node:crypto';
import { validateAgentSurface } from './surface.mjs';
import { createProtocol } from './protocol.mjs';
import { autonomousPolicy, heldPolicy } from './crypto.mjs';
import { discoverDoor, listedDoor } from './discovery.mjs';
import { runJourney } from './journey.mjs';
import { unsetPolicy, removalPhase, blockedPhases, pausePhase } from './policy-phases.mjs';
import { negativePhase } from './negative.mjs';
import { auditPhase } from './audit.mjs';

export { validateAgentSurface } from './surface.mjs';

/** Run against a fresh, real installation using its HTTP and person doors. */
export async function runAgentDoorConformance({ fetch, origin, surface, signer, person, business = 'rer-agent-conformance', consent = randomUUID(), now }) {
 const validation = validateAgentSurface(surface), points = [...validation.points];
 if (!validation.ok) return { ok: false, points };
 if (typeof fetch !== 'function' || !signer?.privateKey || !signer.issuer || !signer.installationId || !signer.kid || !person?.email || !person.cookie || typeof person.sub !== 'string' || !person.sub.trim() || typeof consent !== 'string' || !consent.trim() || new URL(origin).origin !== origin) throw new TypeError('Conformance requires fetch, canonical origin, signer, consent and signed-in person {email,cookie,sub}');
 const c = createProtocol({ fetch, origin, surface, signer, person, business, consent, now, points, agentId: `rer-conformance-${randomUUID()}`, seq: 0, revision: 0, listed: new Map() });
 await c.phase('BASE-AGENT-001.transport', () => discoverDoor(c));
 await c.phase('BASE-AGENT-007.phase0', () => unsetPolicy(c, true));
 await c.phase('BASE-AGENT-007.phase1', () => removalPhase(c));
 await c.phase('BASE-AGENT-013.phase2', async () => { await c.adopt(autonomousPolicy()); await listedDoor(c); await runJourney(c, 'autonomous', { injections: true, replay: true }); });
 await c.phase('BASE-AGENT-013.phase3', async () => { await c.adopt(heldPolicy()); await runJourney(c, 'held', { held: true }); });
 await c.phase('BASE-AGENT-007.phase4', () => blockedPhases(c));
 await c.phase('BASE-AGENT-011.phase5', () => pausePhase(c));
 await c.phase('BASE-AGENT-004.phase6', () => negativePhase(c));
 await c.phase('BASE-AGENT-009.phase7', () => auditPhase(c));
 return { ok: points.every(point => point.ok), points };
}
