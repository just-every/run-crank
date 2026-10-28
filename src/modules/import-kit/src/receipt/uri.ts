// URIs are split and their hosts checked by fixed ASCII grammars, never by the runtime URL parser: WHATWG host parsing
// applies UTS #46 IDNA tables that differ between Node and workerd releases, so one string could parse on one runtime
// and fail on another. The patterns carry no flags, so only their explicit ASCII ranges decide letter case.
const uriParts = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#([^]*))?$/;
const hostAndPort = /^([^:]*)(?::([1-9][0-9]{0,4}))?$/;
const dottedQuad = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const ldhLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
// A last label WHATWG would read as an IPv4 number.
const numericLabel = /^(?:[0-9]+|0[Xx][0-9A-Fa-f]*)$/;

export interface UriParts {
  /** Lower case. */
  scheme: string;
  authority?: string;
  path: string;
  query?: string;
  fragment?: string;
}

/** RFC 3986 appendix B on a string that starts with a scheme; callers check each part's characters. */
export function splitUri(text: string): UriParts | undefined {
  const parts = uriParts.exec(text);
  if (!parts) return undefined;
  const [, scheme, authority, path, query, fragment] = parts;
  // The scheme is ASCII, where toLowerCase folds only A-Z.
  return { scheme: scheme!.toLowerCase(), authority, path: path!, query, fragment };
}

/** `[userinfo "@"] host [":" port]`; a port is 1 to 65535 without leading zeros. */
export function splitAuthority(authority: string): { userinfo?: string; host: string } | undefined {
  const at = authority.lastIndexOf('@');
  const address = hostAndPort.exec(authority.slice(at + 1));
  if (!address || Number(address[2] ?? 1) > 65535) return undefined;
  return at < 0 ? { host: address[1]! } : { userinfo: authority.slice(0, at), host: address[1]! };
}

/**
 * Letter-digit-hyphen labels (an IDN only as its xn-- labels, which are not decoded) with an optional final dot and a
 * last label that is not numeric, or a dotted-quad IPv4 address without leading zeros.
 */
export function isAsciiHostname(host: string): boolean {
  if (dottedQuad.test(host)) return true;
  const labels = (host.endsWith('.') ? host.slice(0, -1) : host).split('.');
  return labels.every((label) => ldhLabel.test(label)) && !numericLabel.test(labels[labels.length - 1]!);
}
