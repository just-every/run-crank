/** Whether a name (an object key, a header name, the name in a `[name, value]`
 * pair, a URL query or fragment key) names a credential, by its whole parts.
 *
 * A name is split into lower-case parts at camelCase and PascalCase boundaries
 * (`apiKey`, `XAPIKey`), at `_`, `-`, `.`, spaces and any other non-letter, and
 * at digits (`token2` is `token`). A name is a credential when its parts are a
 * credential word or phrase, never because a part only contains one: `keyword`,
 * `monkey`, `author`, `signal`, `design` and `tokenizer` hold the letters of a
 * credential word and are not credentials. */
export interface CredentialName {
  /** The name's letters, lower-cased: `apiKey` and `api_key` are both `apikey`. */
  name: string;
  /** The word's plural (`tokens`, `apiKeys`): it holds credentials only as text, so a count stays. */
  plural: boolean;
  /** `auth`, `X-Auth` or `credential(s)`: its value is a credential when it is
   * text that names no scheme or mode (`include`, `oauth2`), or a list with such
   * a member; an object under it is searched field by field instead. */
  container: boolean;
}
/** `refuse`: the whole name is a credential phrase, so a pagination cursor such as
 * `next_page_token` or a count such as `input_tokens` is not one. `remove`: the
 * name ends in a credential word (`pushToken`, `webhook_url`), the wider net of
 * the import door, which drops the value and keeps the record. `query`: a URL
 * query or fragment key, as `remove` plus a bare `key` and `X-Amz-Signature`. */
export type CredentialNameMode = 'refuse' | 'remove' | 'query';
/** Where a name sits in `refuse` or `remove` mode: a record `field`, or an HTTP
 * `header` name (a `[name, value]` tuple, a key of a `headers` object, a
 * `{name|key, value}` pair in a header list). `sig`, `signature` and `sessionId` are credentials only as
 * header names and URL query or fragment keys, never as record fields, so an
 * agent's `signature` or a chat's `session_id` imports. */
export type CredentialNamePlace = 'field' | 'header';

const WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'cookie', 'authorization', 'bearer', 'credential']);
/** Words that make a trailing `key` a credential: `api key`, `secret key`, `Ocp-Apim-Subscription-Key`. A bare `key` or `primaryKey` is not. */
const KEY_QUALIFIERS = new Set(['api', 'access', 'private', 'secret', 'auth', 'client', 'integration', 'routing', 'service', 'signing', 'session',
  'refresh', 'subscription', 'functions', 'consumer', 'app', 'license', 'master', 'encryption', 'admin']);
/** URL query and fragment keys only: `?application_key=` (Datadog), `?user_key=` (3scale), `?account_key=`, `?deploy_key=`, `?shared_key=`, and `?token_auth=` (Matomo), `?basic_auth=`. */
const QUERY_KEY_QUALIFIERS = new Set(['application', 'user', 'account', 'deploy', 'shared']);
const QUERY_AUTH_QUALIFIERS = new Set(['token', 'basic', 'http', 'proxy', 'api']);
const TOKEN_QUALIFIERS = ['access', 'refresh', 'auth', 'api', 'bearer', 'id', 'session', 'csrf', 'xsrf', 'bot', 'push', 'oauth', 'jwt'];
const SECRET_QUALIFIERS = ['client', 'app', 'api', 'oauth', 'webhook', 'signing', 'shared'];
const PASSWORD_QUALIFIERS = ['http', 'db', 'ftp', 'smtp', 'admin', 'user', 'basic', 'proxy', 'root', 'mail', 'login'];
/** One-word credentials however a name splits them: a `passphrase` (`passPhrase`), a `jwt`, and Java's and PHP's session
 * cookies (`JSESSIONID`, `jsessionId`, `PHPSESSID`). They name nothing else, so they count as fields, header names and URL keys. */
const SPELLED = /^(?:passphrase|jwt|jsessionid|phpsessid)(s?)$/;
/** What may stand before one in `refuse` mode (`ssh_passphrase`, `id_jwt`). */
const SPELLED_QUALIFIERS = new Set([...PASSWORD_QUALIFIERS, ...TOKEN_QUALIFIERS, 'ssh', 'key', 'gpg', 'pgp', 'private']);
/** What may stand before a credential word in `refuse` mode, which names the whole phrase (`access token`, `http password`). */
const QUALIFIERS: Record<string, ReadonlySet<string>> = {
  token: new Set(TOKEN_QUALIFIERS), secret: new Set(SECRET_QUALIFIERS),
  password: new Set(PASSWORD_QUALIFIERS), passwd: new Set(PASSWORD_QUALIFIERS), pwd: new Set(PASSWORD_QUALIFIERS),
  key: KEY_QUALIFIERS,
};
/** The same phrases written as one lower-case part (`apikey`, `accesstoken`, `clientsecret`, `httppassword`, `webhookurl`). */
const COMPOUND = new RegExp('^x?(?:'
  + `(?:${[...KEY_QUALIFIERS].join('|')})(?:key)|(?:${TOKEN_QUALIFIERS.join('|')})(?:token)|(?:${SECRET_QUALIFIERS.join('|')})(?:secret)`
  + `|(?:${PASSWORD_QUALIFIERS.join('|')})(?:password|passwd|pwd)|webhook(?:url)|cal(?:url))(s?)$`);
/** A scheme or mode an `auth` or `credentials` field names, never a credential:
 * fetch's `include`, `same-origin` and `omit`, HTTP and API authentication schemes, and boolean
 * words (Keycloak's `smtpServer.auth: "true"`). */
const SCHEME = /^(?:omit|sameorigin|include|none|noauth|inherit|anonymous|basic|bearer|digest|negotiate|ntlm|kerberos|oauth(?:1|2|10|20|1a)?|apikey|jwt|hawk|hmac|aws|awsv4|sigv4|awssigv4|edgegrid|mutual|vapid|token|password|cookie|session|header|query|true|false|yes|no|on|off|enabled|disabled)$/;

/** Whether text under an `auth` or `credentials` name names a scheme or mode (`include`, `oauth2`, `Bearer`, `same-origin`). */
export function credentialScheme(text: string): boolean {
  return SCHEME.test(text.trim().toLowerCase().replace(/[\s_.-]/g, ''));
}
/** Whether an object under this key holds HTTP headers by name (`headers`, `customHttpHeaders`, `header`). */
export function headerContainer(key: string): boolean {
  const last = nameParts(key).at(-1);
  return last === 'headers' || last === 'header';
}
/** Under `auth`, `X-Auth`, `credential` or `credentials`, a member holding the credential under a generic name: `value`
 * (Keycloak's `{type: 'password', value}`, `credential: {type: 'apiKey', value}`), `pass` and `pw` (nodemailer's
 * `{user, pass}`), or a name whose first part is `secret` (Keycloak's `secretData`). Its name's letters, or undefined. */
export function credentialMember(name: string): string | undefined {
  const parts = nameParts(name);
  return (parts.length === 1 && /^(?:value|pass|pw)$/.test(parts[0])) || parts[0] === 'secret' ? parts.join('') : undefined;
}

/** A name's lower-case parts, without digits. Format characters and accents are folded away first. */
export function nameParts(name: string): string[] {
  const text = name.normalize('NFKC').replace(/[\p{Cf}\p{M}]/gu, '');
  return (text.match(/\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lo}+/gu) ?? []).map(part => part.toLowerCase());
}

export function credentialName(name: string, mode: CredentialNameMode, place: CredentialNamePlace = 'field'): CredentialName | undefined {
  const parts = nameParts(name), last = parts.at(-1), before = parts.at(-2);
  if (last === undefined) return undefined;
  const letters = name.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, '').slice(-64);
  const compound = COMPOUND.exec(last);
  if (compound) return { name: letters, plural: compound[1] === 's', container: false };
  // A header's leading `x-` (`x-api-key`, `X-Auth-Token`) is not part of the phrase; `refuse` mode takes the rest whole.
  const phrase = parts.length > 1 && parts[0] === 'x' ? parts.slice(1) : parts;
  const found = (plural: boolean, container = false) => ({ name: letters, plural, container });
  const qualifier = (word: string | undefined) => word !== undefined && (KEY_QUALIFIERS.has(word) || (word.startsWith('x') && KEY_QUALIFIERS.has(word.slice(1))));
  const strict = mode === 'refuse';
  // A URL key or a header name: where `sig`, `signature` and `sessionId` are credentials.
  const header = mode === 'query' || place === 'header';
  for (let size = 1; size <= Math.min(3, phrase.length); size++) {
    const spelled = SPELLED.exec(phrase.slice(-size).join(''));
    if (spelled && (!strict || phrase.length === size || (phrase.length === size + 1 && SPELLED_QUALIFIERS.has(phrase[0])))) return found(spelled[1] === 's');
  }
  // `credentials` holds a credential object as one value; the other plurals hold a list or map of text.
  const word = last === 'credentials' ? 'credential' : WORDS.has(last) ? last : last.endsWith('s') && WORDS.has(last.slice(0, -1)) ? last.slice(0, -1) : undefined;
  if (word !== undefined) {
    const plural = word !== last && last !== 'credentials';
    // `refuse` mode: the word alone or after one qualifier (`token`, `access_token`), and `pwd` after anything.
    const named = phrase.length === 1 || (phrase.length === 2 && QUALIFIERS[word]?.has(phrase[0]) === true) || word === 'pwd';
    if (!strict || named) return found(plural, word === 'credential' && mode !== 'query');
  }
  if (last === 'key' || last === 'keys') {
    // `refuse` mode: `api_key`, `x-functions-key`, and `secret`/`subscription`/`functions` before the key under any name.
    const named = phrase.length === 2 || (before !== undefined && ['secret', 'subscription', 'functions'].includes(before));
    if (qualifier(before) && (!strict || named)) return found(last === 'keys');
    // A bare `key` is a credential only as a URL query or fragment key (the `?key=` convention).
    if (mode === 'query' && parts.length === 1 && last === 'key') return found(false);
    if (mode === 'query' && before !== undefined && QUERY_KEY_QUALIFIERS.has(before)) return found(last === 'keys');
  }
  // A session id is a credential as a header or URL key (`Session-Id`, `?sessionid=`), never as a record's field (a chat's `session_id`).
  const session = /^x?sessionid(s?)$/.exec(last);
  if (header && session) return found(session[1] === 's');
  if (header && last === 'id' && before === 'session' && (!strict || phrase.length === 2)) return found(false);
  if (!strict && last === 'url' && (before === 'webhook' || before === 'cal')) return found(false);
  // A signature is a credential as a whole header name (`Signature`) and, as a query key, as its last part (an Azure SAS `sig`, `X-Amz-Signature`); an agent's `signature` field is not.
  if ((last === 'sig' || last === 'signature') && (mode === 'query' || (place === 'header' && parts.length === 1))) return found(false);
  if (last === 'auth' && (parts.length === 1 || (parts.length === 2 && before === 'x'))) return found(false, mode !== 'query');
  if (mode === 'query' && last === 'auth' && before !== undefined && QUERY_AUTH_QUALIFIERS.has(before)) return found(false);
  // A query key written as one part that ends in an unambiguous phrase: HubSpot's `?hapikey=`.
  if (mode === 'query' && parts.length === 1 && /(?:apikey|accesstoken|authtoken)$/.test(last)) return found(false);
  return undefined;
}
