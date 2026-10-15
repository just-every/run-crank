export class OidcError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'OidcError'; this.code = code; this.status = status; }
}
export function fail(code = 'oidc_invalid_response', status = 400) { throw new OidcError(code, status); }
export function check(value, code, status) { if (!value) fail(code, status); }
