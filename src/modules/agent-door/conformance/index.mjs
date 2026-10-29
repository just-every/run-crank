import { capabilitySet, offers } from '../capabilities.mjs';
import { scopedSurface, refusalPhase } from './subset.mjs';
import { subscriptionPhase } from './subscription.mjs';
import { randomUUID } from 'node:crypto';
import { validateAgentSurface } from './surface.mjs';
import { createProtocol } from './protocol.mjs';
import { autonomousPolicy, heldPolicy } from './crypto.mjs';
import { discoverDoor, listedDoor } from './discovery.mjs';
import { runJourney } from './journey.mjs';
import { unsetPolicy, removalPhase, blockedPhases, pausePhase, consentRevocationPhase } from './policy-phases.mjs';
import { negativePhase } from './negative.mjs';
import { replayAdmissionPhase } from './replay.mjs';
import { webhookPhase } from './webhooks.mjs';
import { recordSecurityPhase } from './security.mjs';
import { crossSponsorPhase } from './sponsors.mjs';
import { auditPhase } from './audit.mjs';
import { invocationPhase } from './invocation.mjs';

export { validateAgentSurface } from './surface.mjs';

/** Run against a fresh, real installation using its HTTP and person doors. */
export async function runAgentDoorConformance({ fetch, invoke, origin, surface, signer, person, sponsors = [person], webhooks, business = 'rer-agent-conformance', consent = randomUUID(), now, prove, nativeJourney, nativeStep, prepare }) {
 const validation = validateAgentSurface(surface), points = [...validation.points];
 if (!validation.ok) return { ok: false, points };
 const capabilities = capabilitySet(surface.capabilities);
 surface = scopedSurface(surface);
 if (typeof fetch !== 'function' || !signer?.privateKey || !signer.issuer || !signer.installationId || !signer.kid || !person?.email || !person.cookie || typeof person.sub !== 'string' || !person.sub.trim() || typeof consent !== 'string' || !consent.trim() || new URL(origin).origin !== origin) throw new TypeError('Conformance requires fetch, canonical origin, signer, consent and signed-in person {email,cookie,sub}');
 const c = createProtocol({ fetch, origin, surface, signer, person, business, consent, now, prove, nativeStep, prepare, points, agentId: `rer-conformance-${randomUUID()}`, seq: 0, revision: 0, listed: new Map() });
 await c.phase('BASE-AGENT-001.transport', () => discoverDoor(c));
 await c.phase('BASE-AGENT-007.phase0', () => unsetPolicy(c, true));
 await c.phase('BASE-AGENT-007.phase1', () => removalPhase(c));
 await c.phase('BASE-AGENT-013.phase2', async () => { await c.adopt(autonomousPolicy()); await c.prepare('autonomous'); await listedDoor(c); await runJourney(c, 'autonomous', { injections: true, replay: true }); });
 await c.phase('BASE-AGENT-013.phase3', async () => { await c.prepare('held'); await c.adopt(heldPolicy()); await runJourney(c, 'held', { held: true }); });
 await c.phase('BASE-AGENT-007.phase4', () => blockedPhases(c));
 await c.phase('BASE-AGENT-011.phase5', () => pausePhase(c));
 await c.phase('BASE-AGENT-004.phase6', () => negativePhase(c));
 await c.phase('BASE-AGENT-004.consent', () => consentRevocationPhase(c));
 if (invoke) await c.phase('BASE-AGENT-012.invocation', () => invocationPhase(c, invoke));
 if (nativeJourney) await c.phase('BASE-AGENT-013.native-journey', async () => { await nativeJourney({ tool: c.tool }); c.add('BASE-AGENT-013.native-journey', true); });
 if (surface.tools.some(tool => tool.authority === 'none')) await c.phase('BASE-AGENT-005.no-subject', () => recordSecurityPhase(c));
 if (surface.verification?.replayAdmission) await c.phase('BASE-AGENT-012.replay', () => replayAdmissionPhase(c, surface.verification.replayAdmission));
 if (webhooks) await c.phase('BASE-AGENT-006.webhook', () => webhookPhase(c, webhooks));
 await c.phase('BASE-AGENT-subset.refusals', () => refusalPhase(c));
 if (capabilities.mode === 'declared' && offers(surface.capabilities, 'subscriptions')) await c.phase('BASE-AGENT-subset.subscriptions', () => subscriptionPhase(c));
 await c.phase('BASE-AGENT-009.phase7', () => auditPhase(c));
 if (sponsors.length > 1) await c.phase('BASE-AGENT-004.cross-sponsor', () => crossSponsorPhase(c, sponsors));
 return { ok: points.every(point => point.ok), points, capabilities };
}
