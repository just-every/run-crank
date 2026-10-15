// The one-time owner sign-in link that `rer signin` mints with the deployment's
// own Cloudflare credentials. rer writes the grant straight into the auth D1
// (accounts/schema/owner-signin.sql) and prints the link once; the Worker
// consumes it (accounts/owner-signin.mjs). Only this digest is stored.
export const OWNER_SIGNIN_SECONDS = 900;
export const OWNER_SIGNIN_PATH = '/auth/owner-signin';
export async function ownerSigninDigest(token) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`owner-signin\0${token}`));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
