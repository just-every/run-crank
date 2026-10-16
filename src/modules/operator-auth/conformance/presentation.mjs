// Shared black-box presentation checks run against each consumer's actual Worker.
export async function checkConfirmation(response, { kind, productName, minutes = 15, token, signInPath = '/signin', confirmationFonts = false, theme }) {
  const valid = !!kind;
  expect(response.status === (valid ? 200 : 400), 'confirmation status');
  expect(response.headers.get('set-cookie') === null, 'preview must be cookie-free');
  expect(response.headers.get('referrer-policy') === (valid ? 'strict-origin' : 'no-referrer'), 'preview referrer policy');
  const html = await response.text();
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  expect(styles.length === 1, 'one self-contained stylesheet');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(styles[0][1]));
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const fontsPolicy = confirmationFonts ? " 'self'; font-src 'self'" : '';
  // A declared seed theme is one same-origin stylesheet whose fonts and logo the app serves.
  const sources = theme ? `style-src 'self' 'sha256-${hash}'; font-src 'self'; img-src 'self'` : `style-src 'sha256-${hash}'${fontsPolicy}`;
  expect(response.headers.get('content-security-policy') === `default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; ${sources}`, 'only approved stylesheet and font CSP sources');
  const themeLink = theme && `<link rel="stylesheet" href="${escape(theme)}">`;
  const allLinks = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]);
  expect(allLinks.filter(link => link === themeLink).length === (theme ? 1 : 0), 'the declared theme stylesheet only');
  expect(!theme || html.startsWith('<!doctype html><html lang="en" class="rer-themed">'), 'themed document');
  const links = allLinks.filter(link => link !== themeLink);
  if (confirmationFonts) {
    expect(links.length === 2, 'one font stylesheet and one primary preload');
    const resources = links.map(link => {
      const attributes = [...link.matchAll(/\s([a-z-]+)="([^"]*)"/g)];
      const attrs = Object.fromEntries(attributes.map(match => [match[1], match[2]]));
      expect(attributes.length === Object.keys(attrs).length && Object.keys(attrs).every(name => ['rel', 'href', 'as', 'type', 'crossorigin'].includes(name)), 'font links have no event or unexpected attributes');
      expect(link.replace(/\s[a-z-]+="[^"]*"/g, '').match(/^<link\s*\/?>$/i), 'font links contain only parsed attributes');
      expect(typeof attrs.href === 'string' && attrs.href.startsWith('/') && !attrs.href.startsWith('//') && !/[\\&?#]/.test(attrs.href) && new URL(attrs.href, 'https://font.conformance.test').origin === 'https://font.conformance.test', 'font resources use fixed same-origin paths without credentials');
      return attrs;
    });
    expect(resources.filter(attrs => attrs.rel === 'stylesheet' && /\.css$/i.test(attrs.href) && Object.keys(attrs).length === 2).length === 1, 'one same-origin font stylesheet');
    expect(resources.filter(attrs => attrs.rel === 'preload' && attrs.as === 'font' && /^font\//.test(attrs.type ?? '') && attrs.crossorigin === 'anonymous' && /\.(woff2?|ttf|otf)$/i.test(attrs.href)).length === 1, 'one reusable primary font preload');
  } else expect(links.length === 0, 'standalone confirmation remains self-contained');
  expect(!/<script|<img|\bon[a-z]+\s*=|style=|url\s*\(|@import|https?:\/\//i.test(html.replace(/<link\b[^>]*>/gi, '')), 'no other resources or inline attributes');
  expect(html.includes(escape(productName)), 'escaped product name');
  if (valid) {
    expect(html.includes(`<h1>${kind === 'invite' ? 'Accept your invitation to' : 'Confirm sign-in to'} ${escape(productName)}</h1>`), 'plain confirmation heading');
    expect(html.includes(`This link works once and expires in ${kind === 'invite' ? '7 days' : `${minutes} minutes`}.`), 'preview lifetime');
    expect(html.includes('<button type="submit">Confirm</button>'), 'explicit confirmation control');
    expect(html.includes(`<input type="hidden" name="token" value="${token}">`) && html.split(token).length === 2, 'token appears only in hidden field');
  } else {
    expect(html.includes(`href="${escape(signInPath)}">Request a new link`), 'configured replacement link');
  }
}

export function checkMail(message, { kind, productName, token }) {
  expect(message.subject === (kind === 'invite' ? `You're invited to ${productName}` : `Your sign-in link for ${productName}`), 'plain mail subject');
  expect(!message.subject.includes(token), 'subject contains no credential');
  for (const part of [message.text, message.html]) {
    expect(typeof part === 'string' && part.includes(`This link works once and expires in ${kind === 'invite' ? '7 days' : '15 minutes'}.`), 'multipart expiry');
    expect(part.split(token).length === 2 && (part.match(/https?:\/\//g) ?? []).length === 1, 'one confirmation URL per part');
  }
  expect((message.html.match(/<a /g) ?? []).length === 1 && message.html.includes('>Confirm</a>'), 'one confirmation mail button');
  expect(message.html.includes(escape(productName)), 'escaped mail product name');
}
function escape(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function expect(value, label) { if (!value) throw new Error(`Operator-auth presentation contract failed: ${label}`); }
