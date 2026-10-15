import { pageResponse } from '../page.mjs';

// The owner's sign-in settings, in the same frame (and seed theme) as sign-in.
export function identitySettingsPage({ idpSignIn }, branding) {
 const content = '<p>Allow invited people to sign in through your linked identity provider. Email links remain available to the owner.</p>'
  + `<form action="/auth/settings/identity" method="post"><input type="hidden" name="setting" value="identity"><label class="check"><input type="checkbox" name="idpSignIn" value="true"${idpSignIn ? ' checked' : ''}>Allow provider sign-in</label><button>Save settings</button></form>`
  + '<p class="secondary-link"><a href="/app">Back to app</a></p>';
 return pageResponse({ branding, title: 'Sign-in settings', heading: 'Sign-in settings', content, referrer: 'strict-origin' });
}
