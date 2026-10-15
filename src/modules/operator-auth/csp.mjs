// Inline product labels add exact CSP hashes without broadening other sources.

/** The CSP source token for an exact inline text. */
export async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(bytes)))}'`;
}

// Allow exactly one more inline source in a directive the document already
// restricts. Inline content an existing directive already permits stays as is.
export function allow(policy, directive, source) {
  const parts = policy.split(';').map(part => part.trim()).filter(Boolean);
  const find = name => parts.findIndex(part => part.split(/\s+/)[0].toLowerCase() === name);
  let index = find(directive);
  if (index < 0) {
    const fallback = find('default-src');
    if (fallback < 0) return policy;
    parts.push([directive, ...parts[fallback].split(/\s+/).slice(1)].join(' '));
    index = parts.length - 1;
  }
  const tokens = parts[index].split(/\s+/);
  if (tokens.includes("'unsafe-inline'") && !tokens.some(token => /^'(?:nonce|sha256|sha384|sha512)-/.test(token))) return parts.join('; ');
  parts[index] = [...tokens.filter(token => token !== "'none'"), source].join(' ');
  return parts.join('; ');
}
