// Trusted server integration only. The caller verifies the Business document;
// its nonce guard and every account mutation share one D1 batch.
import { administration, displayName } from './admin.mjs';
import { bindPolicyActor } from '../scheduled/fence.mjs';
import { normalizeEmail } from '../policy.mjs';
import { emailAllowed } from './roles.mjs';
import { deny } from '../errors.mjs';

export function businessTeam(context) {
  const { store, accounts, config, clock, authorize } = context;
  return Object.freeze({
    async ownerEmail() { return (await accounts.owner())?.email ?? null; },
    async prepare({ members, managed, ownerEmail, roles, guard }) {
      const owner = await accounts.owner();
      if (!owner || owner.email !== normalizeEmail(ownerEmail)) deny('owner_required', 403);
      const operator = await store.operator(owner.id);
      if (!operator || operator.email !== owner.email || operator.role !== 'owner' || operator.status !== 'active' || !emailAllowed(operator.email, config.allowList)) deny('owner_required', 403);
      if (!guard || typeof guard.sql !== 'string' || !Array.isArray(guard.args)) deny('invalid_business_guard', 503);
      if (![roles?.admin, roles?.member].every(role => role === 'admin' || role === 'member')) deny('invalid_role', 400);
      const actor = Object.freeze({ operator });
      bindPolicyActor(actor, () => ({ sql: `(${guard.sql}) AND EXISTS(SELECT 1 FROM oa_operators bo
        WHERE bo.id=? AND bo.email=? AND bo.version=? AND bo.status='active' AND bo.role='owner'
        AND bo.id=(SELECT o.id FROM oa_operators o LEFT JOIN oa_bootstrap b ON b.claim_id=o.id
          WHERE o.role='owner' AND o.status='active' ORDER BY b.claim_id IS NULL,o.created_at,o.id LIMIT 1))`,
      args: [...guard.args, operator.id, operator.email, operator.version] }));
      const fence = store.actorFence(actor, clock());
      const pending = [], rows = [];
      // Abort the whole caller transaction if ownership changed, even when this
      // document contains only conflicts or unchanged members.
      const statements = [[`INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at)
        SELECT ?,NULL,'business:authority_changed','{}',? WHERE NOT (${fence.sql})`,
        [crypto.randomUUID(), clock(), ...fence.args]]];
      const audit = (action, id, condition = 'changes()>0', args = []) => statements.push([
        `INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) SELECT ?,CASE WHEN (${condition}) THEN ? ELSE NULL END,?,?,?`,
        [crypto.randomUUID(), ...args, operator.id, action, JSON.stringify({ operatorId: id, via: `via Business by ${operator.email}` }), clock()],
      ]);
      const allow = async (action, target, role) => {
        if (target?.role === 'owner' || !await authorize({ actor: operator, action, target, role })) deny('business_team_denied', 403);
      };
      const request = new Request(new URL('/auth/invite', config.origin), { method: 'POST', headers: { origin: config.origin, host: new URL(config.origin).host } });
      const desired = new Map(members.map(member => [normalizeEmail(member.email), member]));
      const previous = new Map(managed.filter(row => row.operatorId).map(row => [normalizeEmail(row.email), row]));
      const update = async (target, changes, action) => {
        await allow(action, target, changes.role);
        const changed = changes.role !== target.role || changes.status !== target.status;
        statements.push([`UPDATE oa_operators SET role=?,status=?,display_name=? WHERE id=? AND email=? AND version=? AND role!='owner' AND ${fence.sql}`,
          [changes.role, changes.status, changes.displayName, target.id, target.email, target.version, ...fence.args]]);
        audit(action, target.id);
        return { ...target, ...changes, version: target.version + (changed ? 1 : 0) };
      };
      for (const email of new Set([...desired.keys(), ...previous.keys()])) {
        const member = desired.get(email), prior = previous.get(email);
        // The roster address is a durable Business key, not the operator's
        // current sign-in address. Self-service email changes keep this ID.
        let target = prior ? await store.operator(prior.operatorId) : await store.byEmail(email);
        const oldRole = target?.role;
        if (target?.role === 'owner' || !prior && (email === owner.email || target) || prior && !target) {
          // Never adopt an unrelated account, or discard a recorded identity
          // because its old address now belongs to another account.
          if (member || prior) rows.push({ email, operatorId: prior?.operatorId ?? null, invite: member?.invite ?? prior.invite, state: 'conflict' });
          continue;
        }
        if (!member) {
          if (target.status !== 'inactive') target = await update(target, { ...target, status: 'inactive' }, 'operators:deactivate');
          rows.push({ email, operatorId: target.id, invite: prior.invite, state: 'inactive' });
          continue;
        }
        const role = roles[member.role];
        if (role !== 'admin' && role !== 'member') deny('invalid_role', 400);
        const name = displayName(member.name);
        if (target && target.role !== role) target = await update(target, { ...target, role }, 'operators:role');
        const cancelled = target?.status === 'inactive' && !!await store.cancellation(target.id);
        if (target?.status === 'inactive' && !cancelled) target = await update(target, { ...target, status: 'active' }, 'operators:reactivate');
        if (!target || cancelled || target.status === 'invited' && member.invite > (prior?.invite ?? -1) || target.status === 'invited' && target.role !== oldRole) {
          // Preparation is shared with the public administration.invite path.
          // A preceding role write is represented in the read snapshot only;
          // the exact expected version is repeated in its invitation SQL.
          const plan = await administration({ ...context, authenticate: async () => actor })
            .prepareInvitation(request, { email: target?.email ?? email, displayName: name, role }, { operator: target });
          statements.push(...plan.statements);
          audit('operators:invite', plan.mutation.operatorId, 'EXISTS(SELECT 1 FROM oa_tokens WHERE id=?)', [plan.mutation.token.id]);
          pending.push(plan.afterCommit);
          target = { id: plan.mutation.operatorId, status: 'invited' };
        } else if (target.displayName !== name) target = await update(target, { ...target, displayName: name }, 'operators:role');
        rows.push({ email, operatorId: target.id, invite: member.invite, state: target.status });
      }
      return { statements: statements.map(([sql, args]) => store.statement(sql, args)), rows,
        async afterCommit() { for (const send of pending) await send(); } };
    },
  });
}
