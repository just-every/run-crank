// Only protocol-created principals carry a pin. External admission works without
// the OIDC protocol tables; a pinned callback repeats this fence in its batch.
export function providerPinFence(pin) {
  return pin ? {
    sql: `EXISTS(SELECT 1 FROM oa_identity_providers WHERE provider_id=? AND status='linked' AND issuer=? AND client_id=? AND linked_at=?)`,
    args: [pin.id, pin.issuer, pin.clientId, pin.linkedAt],
  } : { sql: '1', args: [] };
}

export function recordProviderPin(pin, sessionId) {
  return pin ? [[`INSERT INTO oa_provider_session_pins(session_id,provider_id,issuer,client_id,linked_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM oa_sessions WHERE id=?)`,
    [sessionId, pin.id, pin.issuer, pin.clientId, pin.linkedAt, sessionId]]] : [];
}
