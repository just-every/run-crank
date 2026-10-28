// Trusted server callers have already admitted a delegated principal. These
// commands reuse native administration, without minting or inventing a session.
import { administration } from './admin.mjs';
import { bindPolicyActor } from '../scheduled/fence.mjs';
import { emailAllowed } from './roles.mjs';
import { deny } from '../errors.mjs';
import { normalizeEmail } from '../policy.mjs';

export function delegatedAdministration(context, { personId, auditLabel, agentId }) {
  const { store, config } = context;
  if (typeof agentId !== 'string' || !agentId || typeof personId !== 'string' || !personId || typeof auditLabel !== 'string' || !auditLabel.trim()) deny('invalid_delegation', 400);
  const request = new Request(new URL('/auth/delegated-administration', config.origin), {
    method: 'POST', headers: { origin: config.origin, host: new URL(config.origin).host },
  });
  async function commands() {
    const operator = await store.operator(personId);
    if (!operator || operator.status !== 'active' || !emailAllowed(operator.email, config.allowList)) deny('unauthenticated', 401);
    const actor = Object.freeze({ operator });
    bindPolicyActor(actor, () => ({
      sql: "EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND version=? AND status='active' AND role=?)",
      args: [operator.id, operator.version, operator.role],
    }));
    const audit = async event => {
      const extra = context.audit ? await context.audit({ ...event, actorLabel: auditLabel, sponsorId: personId }) : [];
      return [[`INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) VALUES(?,?,?,?,?)`,
        [crypto.randomUUID(), `agent:${agentId}`, event.action, JSON.stringify({ operatorId: event.subjectId, detail: event.detail,
          actor: auditLabel, for: personId }), event.now]], ...extra];
    };
    return administration({ ...context, authenticate: async () => actor, audit });
  }
  return Object.freeze({
    async invite(input) {
      if (input.role === 'owner') deny('delegated_owner_change', 403);
      const admin = await commands();
      const plan = await admin.prepareInvitation(request, input, { operator: await store.byEmail(normalizeEmail(input.email)) });
      if (!await store.invite(plan.mutation, plan.actor, plan)) deny('invitation_conflict', 409);
      await plan.afterCommit();
      return { status: 'accepted' };
    },
    async setRole(operatorId, role) {
      const target = await store.operator(operatorId);
      // A delegation cannot widen its sponsor or transfer owner authority.
      if (operatorId === personId || target?.role === 'owner' || role === 'owner') deny('delegated_owner_change', 403);
      return (await commands()).setRole(request, operatorId, role);
    },
    async listOperators() { return (await commands()).listOperators(request); },
  });
}
