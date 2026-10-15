// The providers an app can offer. Each preset fixes the signing algorithms its
// ID tokens may use (never `none` or HS*) and how far its email claim is
// trusted. GitHub is not an OpenID provider and is not offered.
//
// email:
//   'verified-at'  email_verified with email_verified_at in the last 30 days (Auth)
//   'google'       email_verified, and only for @gmail.com or tokens carrying hd
//   'subject'      never by email: only explicit subjectEmails associations
export const MINIMUM_PROVIDER_VERSION = '1.0.0';
export const PRESETS = Object.freeze({
  auth: Object.freeze({ label: 'Auth', algorithms: ['ES256'], methods: ['private_key_jwt'], email: 'verified-at', interface: 'oidc-provider', scope: 'openid email profile' }),
  google: Object.freeze({ label: 'Google', issuer: 'https://accounts.google.com', algorithms: ['RS256'], methods: ['private_key_jwt', 'client_secret_basic', 'client_secret_post'],
    email: 'google', endpointOrigins: ['https://accounts.google.com', 'https://oauth2.googleapis.com', 'https://www.googleapis.com'], scope: 'openid email' }),
  microsoft: Object.freeze({ label: 'Microsoft', tenantIssuer: tenant => `https://login.microsoftonline.com/${tenant}/v2.0`, algorithms: ['RS256'],
    methods: ['private_key_jwt', 'client_secret_basic', 'client_secret_post'], email: 'subject', endpointOrigins: ['https://login.microsoftonline.com'], scope: 'openid email' }),
  'legacy-rs256': Object.freeze({ label: 'Company', algorithms: ['RS256'], methods: ['private_key_jwt', 'client_secret_basic', 'client_secret_post'], email: 'legacy-verified', scope: 'openid email' }),
  okta: Object.freeze({ label: 'Okta', algorithms: ['RS256'], methods: ['private_key_jwt', 'client_secret_basic', 'client_secret_post'], email: 'subject', scope: 'openid email' }),
});

export function compareVersions(a, b) {
  const parse = v => v.split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export const validVersion = v => typeof v === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(v);
