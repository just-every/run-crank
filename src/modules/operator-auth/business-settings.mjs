import { deny } from './errors.mjs';
import { requirePost } from './http.mjs';

// The integration contains only public branding and owner-visible provenance.
// It never returns the signed document (which includes private team data).
export function businessSettingsControls({ businessSettings, config, accounts, authenticate, requireFreshProof, store, clock }) {
  if (!businessSettings) return {};
  async function owner(request, post = false) {
    if (post) requirePost(request, config);
    const actor = await authenticate(request), current = await accounts.owner();
    if (!actor) deny('unauthenticated', 401);
    if (!current || current.id !== actor.operator.id) deny('owner_required', 403);
    return actor;
  }
  return {
    businessSettings,
    async publicPresentation() {
      const brand = await businessSettings.publicBrand();
      const logo = typeof brand.logo === 'string' && /^\/rer-business-logo\?v=[a-f0-9]{12,64}$/.test(brand.logo) ? brand.logo : undefined;
      return { ...config.branding, ...(brand.displayName ? { productName: brand.displayName } : {}), ...(logo ? { mark: logo } : {}) };
    },
    async businessSettingsInfo(request) {
      await owner(request);
      const value = await businessSettings.read();
      return { business: value.document?.business ?? null, rev: value.rev, appliedAt: value.appliedAt, stopped: value.stopped };
    },
    async stopBusinessSettings(request) {
      const actor = await owner(request, true);
      await requireFreshProof(actor);
      const current = await owner(request);
      if (current.operator.version !== actor.operator.version) deny('authority_changed', 409);
      const sessionFence = store?.actorFence(actor, clock());
      const guard = sessionFence ? { sql: `(${sessionFence.sql}) AND ?=(SELECT o.id FROM oa_operators o
        LEFT JOIN oa_bootstrap b ON b.claim_id=o.id WHERE o.role='owner' AND o.status='active'
        ORDER BY b.claim_id IS NULL,o.created_at,o.id LIMIT 1)`, args: [...sessionFence.args, actor.operator.id] } : undefined;
      await businessSettings.stop(actor.operator.id, guard);
      return { stopped: true };
    },
  };
}
