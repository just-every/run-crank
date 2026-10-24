// Exact input-to-profile permissions, not a credential-name classifier.
// Normalize case once for lookup. SETUP's separate ASCII upper-snake-case
// identifier grammar still applies; no separator, prefix or Unicode folding.
export const BUSINESS_FIELD_INPUTS = Object.freeze(Object.fromEntries(Object.entries({
  owner_email: ['OWNER_EMAIL', 'FIRST_OWNER_EMAIL', 'OPERATOR_EMAIL', 'SEED_ADMIN_EMAIL', 'SETUP_OPERATOR_EMAIL', 'SETUP_OWNER_EMAIL', 'SUPPORT_EMAIL'],
  legal_name: ['LEGAL_NAME', 'TRADING_NAME'],
  timezone: ['WORKSPACE_TIMEZONE', 'LAMP_PAGE_TIMEZONE', 'TIMEZONE'],
  currency: ['WORKSPACE_CURRENCY', 'CURRENCY'],
  jurisdiction: ['JURISDICTION'],
  mail_sender: ['MAIL_FROM', 'EMAIL_FROM', 'MAIL_FROM_ADDRESS', 'MAIL_SENDER'],
  display_name: ['APP_NAME', 'WORKSPACE_NAME', 'DEFAULT_TEAM_NAME', 'LAMP_PAGE_NAME', 'LAMP_PAGE_TAGLINE', 'DISPLAY_NAME', 'BUSINESS_NAME'],
  owner_name: ['OWNER_NAME', 'FIRST_OWNER_NAME', 'OWNER_DISPLAY_NAME'],
  brand_color: ['PRIMARY_COLOR', 'LAMP_ACCENT_COLOR', 'BRAND_COLOR'],
  logo_ref: ['LOGO_REF'],
  entity_type: ['ENTITY_TYPE'],
  state_of_organization: ['STATE_OF_ORGANIZATION'],
  fiscal_year_start: ['FISCAL_YEAR_START'],
  books_start_date: ['BOOKS_START_DATE'],
  tax_method: ['TAX_METHOD'],
  country: ['COUNTRY'],
  state: ['STATE'],
}).map(([field, names]) => [field, Object.freeze(names)])));

/** Shared hint refusal for validators and the installer compiler's vault scope. */
export function businessFieldInputError(field, secretScopes = {}) {
  if (!Object.hasOwn(field, 'businessField')) return;
  if (field.kind === 'secret' || field.type === 'password' || field.secret === true
    || Object.hasOwn(secretScopes, field.name)) {
    return `${field.name} cannot claim Business field ${String(field.businessField)} because it is secret or vault-bound`;
  }
  if (typeof field.businessField !== 'string' || typeof field.name !== 'string') return;
  const names = Object.hasOwn(BUSINESS_FIELD_INPUTS, field.businessField)
    ? BUSINESS_FIELD_INPUTS[field.businessField] : [];
  if (!names.includes(field.name.toUpperCase())) {
    return `${field.name} cannot claim Business field ${field.businessField}: this name is not on the Business-field allow-list: add it in Base's schema table through a Base change, or rename the input to one of: ${names.join(', ') || '(choose a valid Business field first)'}`;
  }
}
