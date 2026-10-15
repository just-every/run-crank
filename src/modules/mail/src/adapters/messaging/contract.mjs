import { fail } from '../../core/errors.mjs';

export function closed(value, fields, code = 'invalid_messaging_response') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key))) fail(code);
  return value;
}
export function identity(value, max = 512, code = 'invalid_messaging_identity') {
  if (typeof value !== 'string' || !value.length || value.trim() !== value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(code);
  return value;
}
export function serviceOrigin(value, mode = 'production') {
  let url;
  try { url = new URL(value); } catch { fail('invalid_messaging_origin'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.origin !== value || url.username || url.password ||
      !(url.protocol === 'https:' || (mode !== 'production' && url.protocol === 'http:' && loopback))) fail('invalid_messaging_origin');
  return value;
}
export function rfc3339(value, code = 'invalid_messaging_timestamp') {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail(code);
  const day = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0 || !Number.isFinite(day.getTime()) ||
      day.toISOString().slice(0, 10) !== value.slice(0, 10) ||
      Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59 ||
      (value.endsWith('Z') === false && (Number(value.slice(-5, -3)) > 23 || Number(value.slice(-2)) > 59))) fail(code);
  return time;
}
export function validateMessagingConfig(config, dependencies) {
  serviceOrigin(config.serviceOrigin, config.mode);
  identity(config.installId, 256, 'invalid_messaging_install');
  identity(config.kid, 256, 'invalid_messaging_key');
  if (config.apiKey !== undefined || config.accountId !== undefined) fail('unsupported_messaging_config');
  const jwk = config.signingKey;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' ||
      !['x', 'y', 'd'].every(field => typeof jwk[field] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(jwk[field])) ||
      (jwk.alg !== undefined && jwk.alg !== 'ES256') || (jwk.use !== undefined && jwk.use !== 'sig') ||
      (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'sign')) ||
      (jwk.kid !== undefined && jwk.kid !== config.kid)) fail('invalid_messaging_key');
  if (dependencies.serviceBinding !== undefined && (!dependencies.serviceBinding || typeof dependencies.serviceBinding.fetch !== 'function')) fail('invalid_service_binding');
  if (dependencies.serviceBinding !== undefined && dependencies.fetch !== undefined) fail('ambiguous_messaging_transport');
}
const codes = {
  rejected: ['suppressed', 'kind_not_granted', 'sender_not_granted', 'app_paused', 'invalid', 'unsubscribe_missing', 'expired', 'provider_rejected_recipient', 'key_reused'],
  rate_limited: ['app_cap', 'recipient_limit', 'provider_rate_limited', 'providers_unavailable'],
  uncertain: ['ambiguous', 'in_progress', 'orphaned'],
};
export function validateMessagingResult(result) {
  const invalid = 'invalid_send_result';
  closed(result, ['provider', 'status', 'providerMessageId', 'code', 'suppression', 'retryAfter'], invalid);
  if (result.provider !== 'messaging' || typeof result.status !== 'string') fail(invalid);
  if (result.status === 'accepted') identity(result.providerMessageId, 1024, invalid);
  else if (result.providerMessageId !== null) fail(invalid);
  if (['accepted', 'development'].includes(result.status)) {
    if (Object.hasOwn(result, 'code')) fail(invalid);
  } else if (!(Object.hasOwn(codes, result.status) && codes[result.status].includes(result.code))) fail(invalid);
  if (result.code === 'suppressed') {
    if (!['hard_bounce', 'complaint', 'provider'].includes(result.suppression)) fail(invalid);
  } else if (Object.hasOwn(result, 'suppression')) fail(invalid);
  const retryable = ['rate_limited', 'uncertain'].includes(result.status);
  if (Object.hasOwn(result, 'retryAfter') && (!retryable || !Number.isSafeInteger(result.retryAfter) || result.retryAfter < 0)) fail(invalid);
  if ((result.status === 'rate_limited' || result.code === 'in_progress') && result.retryAfter === undefined) fail(invalid);
  return result;
}
