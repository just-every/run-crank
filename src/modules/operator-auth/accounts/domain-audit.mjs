import { auditMutation } from './audit.mjs';

export async function auditDomainRule(store, { domain, providerId, now }, actor, audit) {
  const previous = await store.first('SELECT provider_id,created_by,created_at FROM oa_domain_rules WHERE domain=?', [domain]);
  if (providerId === null && !previous) return 0;
  const fence = store.actorFence(actor, now);
  const snapshot = previous
    ? { sql: 'EXISTS(SELECT 1 FROM oa_domain_rules WHERE domain=? AND provider_id=? AND created_by=? AND created_at=?)', args: [domain, previous.provider_id, previous.created_by, previous.created_at] }
    : { sql: 'NOT EXISTS(SELECT 1 FROM oa_domain_rules WHERE domain=?)', args: [domain] };
  // The existing timestamp doubles as the domain rule's monotonic revision.
  const revision = previous ? Math.max(previous.created_at + 1, now) : now;
  const [result] = await auditMutation(store, { audit,
    event: { action: providerId === null ? 'domains.rule.lift' : 'domains.rule.set', actorId: actor.operator.id, subjectId: null, detail: domain, now },
    before: { sql: `${fence.sql} AND ${snapshot.sql}`, args: [...fence.args, ...snapshot.args] },
    after: providerId === null
      ? { sql: 'NOT EXISTS(SELECT 1 FROM oa_domain_rules WHERE domain=?)', args: [domain] }
      : { sql: 'EXISTS(SELECT 1 FROM oa_domain_rules WHERE domain=? AND provider_id=? AND created_by=? AND created_at=?)', args: [domain, providerId, actor.operator.id, revision] },
    statements: [providerId === null
      ? ['DELETE FROM oa_domain_rules WHERE domain=? RETURNING domain', [domain]]
      : [`INSERT INTO oa_domain_rules(domain,provider_id,created_by,created_at) VALUES(?,?,?,?)
          ON CONFLICT(domain) DO UPDATE SET provider_id=excluded.provider_id,created_by=excluded.created_by,created_at=excluded.created_at RETURNING domain`, [domain, providerId, actor.operator.id, revision]]],
  });
  return result.results.length;
}
