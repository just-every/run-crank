/** Apps a connection can be made for, their API domains and accepted credential kinds. */
export type AuthKind = 'bearer' | 'basic' | 'api_key' | 'hmac' | 'oauth2' | 'oauth2_client_credentials' | 'signing_secret'
export interface AppDefinition {
  name: string; kinds: AuthKind[]; domains: string[] | 'declared'
  /** Fields of the stored secret, by credential kind; none ever leave the server. */
  test?: { method: string; url: string }
}
export const APPS: Record<string, AppDefinition> = {
  gusto: { name: 'Gusto', kinds: ['bearer', 'oauth2'], domains: ['api.gusto-demo.com', 'api.gusto.com'] },
  quickbooks: { name: 'QuickBooks sandbox', kinds: ['oauth2'], domains: ['sandbox-quickbooks.api.intuit.com'] },
  http: { name: 'HTTP API', kinds: ['bearer', 'basic', 'api_key', 'hmac', 'oauth2_client_credentials'], domains: 'declared' },
  webhook: { name: 'Webhook signing secret', kinds: ['signing_secret'], domains: [] },
  slack: { name: 'Slack', kinds: ['bearer', 'oauth2'], domains: ['slack.com'], test: { method: 'POST', url: 'https://slack.com/api/auth.test' } },
  hubspot: { name: 'HubSpot', kinds: ['oauth2', 'bearer'], domains: ['api.hubapi.com'], test: { method: 'GET', url: 'https://api.hubapi.com/account-info/v3/details' } },
  google: { name: 'Google', kinds: ['oauth2'], domains: ['www.googleapis.com', 'sheets.googleapis.com', 'gmail.googleapis.com'], test: { method: 'GET', url: 'https://www.googleapis.com/oauth2/v3/userinfo' } },
}

export const SECRET_FIELDS: Record<AuthKind, { required: string[]; optional: string[] }> = {
  bearer: { required: ['token'], optional: ['signing_secret'] },
  basic: { required: ['username', 'password'], optional: [] },
  api_key: { required: ['key'], optional: ['header', 'query'] },
  hmac: { required: ['secret'], optional: ['header', 'algorithm', 'encoding', 'prefix', 'timestamp_header'] },
  oauth2: { required: ['access_token'], optional: ['refresh_token', 'expires_at', 'token_type', 'signing_secret'] },
  oauth2_client_credentials: { required: ['client_id', 'client_secret', 'token_url'], optional: ['scope', 'access_token', 'expires_at'] },
  signing_secret: { required: ['secret'], optional: [] },
}

/** A host is inside a connection's domains when it equals one or is a subdomain of one. */
export function hostAllowed(host: string, domains: string[]) {
  const value = host.toLowerCase()
  return domains.some(domain => value === domain || value.endsWith('.' + domain))
}
