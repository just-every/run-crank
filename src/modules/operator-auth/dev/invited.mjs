// Whether /__dev/personas would list someone beyond the owner and the seed's own
// personas: an active person or one with a live invitation. The keyless guidance page
// uses this one fact to say whether `rer dev --as <email>` has anyone to take; it
// reads no name or address.
export async function hasInvitedPeople({ store, config, declared, now = Date.now() }) {
  const own = [config.OWNER_EMAIL, ...declared.map(persona => persona.email)];
  const row = await store.first(`SELECT 1 AS found FROM oa_operators o WHERE o.email NOT IN (${own.map(() => '?').join(',')})
    AND (o.status='active' OR (o.status='invited' AND EXISTS (SELECT 1 FROM oa_tokens t WHERE t.operator_id=o.id AND t.kind='invite'
      AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>? AND t.operator_version=o.version))) LIMIT 1`, [...own, now]);
  return row !== null && row !== undefined;
}
