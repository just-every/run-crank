import { pageResponse } from '../page.mjs';
import { escapeHtml } from '../http.mjs';

// The owner's sign-in settings, in the same frame (and seed theme) as sign-in.
export function identitySettingsPage({ idpSignIn, providerSetup }, branding, { saved = false, error, status = 200, method = 'GET' } = {}) {
 const states = { linked: 'Linked', configured: 'Configured · connects on first sign-in', unlinked: 'Not linked', 'needs-relink': 'Link needs setup again' };
 const notice = error ? '<p class="notice" role="alert">Provider sign-in could not be enabled. Link or relink your identity provider, then try again.</p>'
  : saved ? `<p class="notice" role="status">Settings saved. Provider sign-in is ${idpSignIn ? 'on' : 'off'}.</p>` : '';
 const setup = providerSetup.providers.length
  ? providerSetup.providers.map(provider => `<p>${escapeHtml(provider.label)}: ${states[provider.state]}</p>`).join('')
  : '<p>No identity provider is configured.</p>';
 const content = notice + '<p>Allow invited people to sign in through your linked identity provider. Email links remain available to the owner.</p>'
  + '<h2>Provider setup</h2>' + setup
  + (!providerSetup.canEnable ? '<p>Have the installation administrator link or relink a provider through the project’s identity setup, then return here to enable sign-in.</p>' : '')
  + `<form action="/auth/settings/identity" method="post"><input type="hidden" name="setting" value="identity"><label class="check"><input type="checkbox" name="idpSignIn" value="true"${idpSignIn ? ' checked' : ''}${!providerSetup.canEnable && !idpSignIn ? ' disabled' : ''}>Allow provider sign-in</label><button>Save settings</button></form>`
  + '<p class="secondary-link"><a href="/app">Back to app</a></p>';
 return pageResponse({ branding, title: 'Sign-in settings', heading: 'Sign-in settings', content, status, method, referrer: 'strict-origin' });
}
