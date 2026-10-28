import { pageResponse } from '../page.mjs';
import { escapeHtml } from '../http.mjs';

// The owner's sign-in settings, in the same frame (and seed theme) as sign-in.
export function identitySettingsPage({ idpSignIn, providerSetup, business }, branding, { saved = false, error, status = 200, method = 'GET' } = {}) {
 const states = { linked: 'Linked', configured: 'Configured · connects on first sign-in', unlinked: 'Not linked', 'needs-relink': 'Link needs setup again' };
 const notice = error === 'step_up_required' ? '<p class="notice" role="alert">Confirm your identity below, then stop Business settings.</p>' : error ? '<p class="notice" role="alert">Provider sign-in could not be enabled. Link or relink your identity provider, then try again.</p>'
  : saved ? `<p class="notice" role="status">Settings saved. Provider sign-in is ${idpSignIn ? 'on' : 'off'}.</p>` : '';
 const setup = providerSetup.providers.length
  ? providerSetup.providers.map(provider => `<p>${escapeHtml(provider.label)}: ${states[provider.state]}</p>`).join('')
  : '<p>No identity provider is configured.</p>';
 const content = notice + '<p>Allow invited people to sign in through your linked identity provider. Email links remain available to the owner.</p>'
  + '<h2>Provider setup</h2>' + setup
  + (!providerSetup.canEnable ? '<p>Have the installation administrator link or relink a provider through the project’s identity setup, then return here to enable sign-in.</p>' : '')
  + `<form action="/auth/settings/identity" method="post"><input type="hidden" name="setting" value="identity"><label class="check"><input type="checkbox" name="idpSignIn" value="true"${idpSignIn ? ' checked' : ''}${!providerSetup.canEnable && !idpSignIn ? ' disabled' : ''}>Allow provider sign-in</label><button>Save settings</button></form>`
  + businessSection(business)
  + '<p class="secondary-link"><a href="/app">Back to app</a></p>';
 return pageResponse({ branding, title: 'Sign-in settings', heading: 'Sign-in settings', content, status, method, referrer: 'strict-origin' });
}

function businessSection(value) {
 if (!value) return '';
 const details = value.business
  ? `<p>Source: Business ${escapeHtml(value.business)}<br>Revision: ${escapeHtml(String(value.rev))}<br>Applied: ${escapeHtml(value.appliedAt ?? 'Not yet applied')}</p>`
  : '<p>No Business settings have been applied.</p>';
 if (value.stopped) return '<h2>Business</h2>' + details + '<p>Business settings are stopped. The last applied settings and team are kept.</p>';
 return '<h2>Business</h2>' + details
  + '<p>The owner can stop receiving settings and team updates from Business. Confirm your identity first.</p>'
  + '<div class="stack"><form method="post" action="/auth/step-up"><input type="hidden" name="action" value="business:stop"><input type="hidden" name="returnTo" value="/auth/settings/identity"><button class="secondary">Confirm identity</button></form>'
  + '<form method="post" action="/auth/settings/business"><button class="secondary">Stop taking settings from Business</button></form></div>';
}
