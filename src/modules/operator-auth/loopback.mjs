// The one loopback predicate every local-only check shares. A local origin's
// host is one of the three loopback hosts or a name under `.localhost`, which
// RFC 6761 reserves for loopback and browsers resolve to it themselves: the
// front door serves each checkout at `http://<name>.localhost:<port>`. Hosted
// origins never pass through this predicate; they must be https.
const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const localhostName = new RegExp(`^(?:${label}\\.)+localhost$`);

/** A name under `.localhost` (lowercase, no trailing dot), such as `cradle.localhost`. */
export function isLocalhostName(hostname) {
  return typeof hostname === 'string' && hostname.length <= 253 && localhostName.test(hostname);
}

/** `localhost`, `127.0.0.1`, `[::1]` (as URL.hostname spells it) or a `*.localhost` name. */
export function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || isLocalhostName(hostname);
}
