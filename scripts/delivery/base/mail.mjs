import {keys, strings} from './bindings.mjs';

const publicNames = ['MAIL_PROVIDER', 'MAIL_FROM', 'MAIL_RELAY_URL'];
const providerLabels = {rer: 'RER managed mail', resend: 'Resend', sendgrid: 'SendGrid', cloudflare: 'Cloudflare Email Sending'};

/** Managed mail is an explicit capability, independent of direct provider adapters. */
export function usesManagedMail(mail) {
  if (mail === undefined) return false;
  keys(mail, ['providers'], 'mail');
  const providers = strings(mail.providers, 'mail providers', /^(rer|resend|sendgrid|cloudflare)$/);
  if (!providers.length) throw Error('Mail requires at least one provider');
  return providers.includes('rer');
}

/** Compose these fields into the seed's committed setup manifest before packaging. */
export function generateMailSetupFields(mail) {
  usesManagedMail(mail);
  if (!mail) throw Error('Mail setup requires a provider declaration');
  const condition = provider => ({field: 'MAIL_PROVIDER', equals: provider});
  const presentations = mail.providers.map(provider => ({when: condition(provider), required: true}));
  return [
    {name: 'MAIL_PROVIDER', label: 'Mail provider', kind: 'select', required: true, default: mail.providers[0],
      options: mail.providers.map(value => ({value, label: providerLabels[value]}))},
    {name: 'MAIL_FROM', label: 'Sender address', kind: 'text', required: false, presentations},
    ...(mail.providers.includes('rer') ? [
      {name: 'MAIL_RELAY_URL', label: 'Managed mail relay URL', kind: 'url', required: true, when: condition('rer')}
    ] : []),
    {name: 'MAIL_API_KEY', label: 'Mail API key', kind: 'secret', input: 'entered', ownerVisible: true,
      required: false, presentations: structuredClone(presentations)},
    ...(mail.providers.includes('cloudflare') ? [
      {name: 'MAIL_ACCOUNT_ID', label: 'Cloudflare account ID', kind: 'text', required: true, when: condition('cloudflare')}
    ] : [])
  ];
}

export function validateMailSpec(spec) {
  if (!usesManagedMail(spec.mail)) return;
  for (const name of publicNames) {
    if (!Object.hasOwn(spec.publicVariables, name)) throw Error(`Managed mail requires public ${name}`);
  }
  if (![...spec.secretNames, ...(spec.optionalSecretNames ?? [])].includes('MAIL_API_KEY')) {
    throw Error('Managed mail requires secret MAIL_API_KEY');
  }
}

/** Check the selected installer's effective fields for RER's assigned provider. */
export function validateMailSetup(mail, manifest) {
  if (!usesManagedMail(mail) || !manifest) return;
  const provider = manifest.fields.find(field => field.name === 'MAIL_PROVIDER');
  if (provider?.kind !== 'select' || !provider.options.some(option => option.value === 'rer')) {
    throw Error('Managed mail setup requires a MAIL_PROVIDER select with the rer option');
  }
  const matches = condition => condition.field === 'MAIL_PROVIDER'
    && (condition.nonEmpty === true || condition.equals === 'rer');
  for (const name of [...publicNames, 'MAIL_API_KEY']) {
    const field = manifest.fields.find(item => item.name === name);
    if (!field || (name === 'MAIL_API_KEY' ? field.kind !== 'secret' : field.kind === 'secret')) {
      throw Error(`Managed mail setup requires ${name === 'MAIL_API_KEY' ? 'secret' : 'public'} ${name}`);
    }
    const presentation = field.presentations?.find(item => matches(item.when));
    if ((field.when && !matches(field.when)) || (field.presentations && !presentation)
      || (presentation?.required ?? field.required) !== true) {
      throw Error(`Managed mail setup requires ${name} with provider rer`);
    }
  }
}
