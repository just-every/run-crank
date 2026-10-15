// Node test harness door: sign a test browser or fetch client in as a persona
// on a running local app. The harness presents the checkout's RER_DEV_KEY; the
// app answers 404 without it. Never import this from Worker code.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEV_KEY_FILE = '.rer/local/dev-key.env';
export async function readDevKey(root) {
  const text = await readFile(join(root, DEV_KEY_FILE), 'utf8');
  const key = /^RER_DEV_KEY=([A-Za-z0-9_-]{43,256})$/m.exec(text)?.[1];
  if (!key) throw new Error(`${DEV_KEY_FILE} holds no RER_DEV_KEY. Run rer setup.`);
  return key;
}

/** Returns the cookies to install ({ name, value }[]) and the redirect target. */
export async function signInAs({ origin, key, as = 'owner', returnTo }) {
  const url = new URL('/auth/dev/enter', origin);
  url.searchParams.set('as', as);
  if (returnTo) url.searchParams.set('returnTo', returnTo);
  const response = await fetch(url, { redirect: 'manual', headers: { 'x-rer-dev-key': key } });
  await response.body?.cancel();
  if (response.status !== 303) throw new Error(`Dev sign-in as ${as} answered HTTP ${response.status}.`);
  const cookies = response.headers.getSetCookie().map(line => line.split(';')[0]).map(pair => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1) }));
  return { cookies, location: response.headers.get('location'), header: cookies.filter(c => c.value).map(c => `${c.name}=${c.value}`).join('; ') };
}
