import { demoEffect } from './modules/demo/index.mjs'
import { createMailSender } from './modules/mail/index.mjs'

function configuredMail(env) {
 return env.MAIL_PROVIDER === 'development'
  ? env.AUTH_LOCAL === 'true' ? createMailSender({ provider: 'development', mode: 'development' }) : undefined
  : env.MAIL_PROVIDER ? createMailSender({ provider: env.MAIL_PROVIDER, mode: 'production', apiKey: env.MAIL_API_KEY, ...(env.MAIL_PROVIDER === 'cloudflare' ? { accountId: env.MAIL_ACCOUNT_ID } : {}) }) : undefined
}

// Delay provider construction until the real effect runs: demo needs no provider key.
export function operatorMail(env) {
 return env.MAIL_PROVIDER ? {
  send: message => demoEffect(
   () => configuredMail(env)?.send(message),
   () => ({ provider: env.MAIL_PROVIDER, status: env.MAIL_PROVIDER === 'development' ? 'development' : 'accepted', providerMessageId: env.MAIL_PROVIDER === 'development' ? null : `demo-${crypto.randomUUID()}` }),
  ),
 } : undefined
}
