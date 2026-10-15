import { hashToken, constantEqual } from './crypto.mjs';

// The rer command line signs in to its own loopback development server on every
// setup and dev start. It proves it holds the private SESSION_SECRET with this
// header so those requests do not spend the owner's sign-in budget. Only a local
// (loopback) configuration honours it; production ignores the header entirely.
// The onboarding adapter derives the same value: HMAC-SHA256(SESSION_SECRET,
// "local-cli\0sign-in") as lowercase hex.
export const LOCAL_CLI_HEADER = 'x-rer-local-cli';

export async function isLocalCli(request, config) {
  if (!config.local) return false;
  const presented = request.headers.get(LOCAL_CLI_HEADER);
  if (!presented) return false;
  return constantEqual(presented, await hashToken(config.SESSION_SECRET, 'local-cli', 'sign-in'));
}
