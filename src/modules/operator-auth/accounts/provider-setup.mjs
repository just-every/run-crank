// Registration state, independent of the sign-in switch and network health.
// Static providers pin on first use; an explicit unlink still requires relinking.
export function providerEnableFence(config) {
  if (config.externalIssuers.length) return { sql: '1', args: [] };
  const clauses = [], args = [];
  for (const provider of config.providers) {
    clauses.push("NOT EXISTS(SELECT 1 FROM oa_identity_providers WHERE provider_id=? AND status='unlinked')");
    args.push(provider.id);
  }
  if (config.dependencies) clauses.push(`EXISTS(SELECT 1 FROM rer_dependency_link l JOIN rer_dependency_keys k ON k.interface=l.interface
    WHERE l.interface='oidc-provider@1' AND l.needs_relink=0)
    AND NOT EXISTS(SELECT 1 FROM oa_identity_providers WHERE provider_id='auth' AND status='unlinked')`);
  return { sql: clauses.length ? clauses.map(sql => `(${sql})`).join(' OR ') : '0', args };
}

export async function providerSetup(db, config) {
  const providers = [];
  if (config.externalIssuers.length) providers.push({ id: 'external', label: 'Verified identity provider', state: 'configured' });
  if (config.providers.length || config.dependencies) {
    let pins = config.providers.length ? (await db.prepare('SELECT provider_id,status FROM oa_identity_providers').all()).results : [];
    for (const provider of config.providers) {
      const pin = pins.find(pin => pin.provider_id === provider.id);
      providers.push({ id: provider.id, label: provider.label ?? provider.id, state: pin?.status ?? 'configured' });
    }
    if (config.dependencies) {
      const link = await db.prepare(`SELECT l.needs_relink,EXISTS(SELECT 1 FROM rer_dependency_keys k WHERE k.interface=l.interface) AS has_key
        FROM rer_dependency_link l WHERE l.interface='oidc-provider@1'`).first();
      if (link && !config.providers.length) pins = (await db.prepare('SELECT provider_id,status FROM oa_identity_providers').all()).results;
      const unlinked = pins.some(pin => pin.provider_id === 'auth' && pin.status === 'unlinked');
      providers.push({ id: 'auth', label: 'Auth', state: !link || unlinked ? 'unlinked' : link.needs_relink || !link.has_key ? 'needs-relink' : 'linked' });
    }
  }
  return { canEnable: providers.some(provider => ['linked', 'configured'].includes(provider.state)), providers };
}
