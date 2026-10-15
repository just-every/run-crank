import { AiError } from './errors.mjs';

export function aiConfig(env = {}, features = {}) {
  return {
    enabled: env.AI_ENABLED === true || env.AI_ENABLED === 'true',
    model: env.AI_MODEL,
    direct: env.AI_BASE_URL || env.AI_API_KEY ? { baseUrl: env.AI_BASE_URL || 'https://api.openai.com/v1', apiKey: env.AI_API_KEY } : undefined,
    models: env.MODELS_SERVICE || env.MODELS_KEY ? { baseUrl: env.MODELS_SERVICE, apiKey: env.MODELS_KEY } : undefined,
    features,
  };
}

export function validBaseUrl(value) {
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
    return (url.protocol === 'https:' || (url.protocol === 'http:' && local)) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function selectTransport(config = {}, feature = 'default') {
  if (config.enabled !== true) throw new AiError('ai_disabled', 503);
  const requested = config.features && Object.hasOwn(config.features, feature) ? config.features[feature] : undefined;
  if (requested !== undefined && !['direct', 'models'].includes(requested)) throw new AiError('ai_misconfigured', 503);
  const configured = ['direct', 'models'].filter(name => config[name] && (config[name].baseUrl || config[name].apiKey));
  const name = requested ?? (configured.length === 1 ? configured[0] : undefined);
  const transport = name && config[name];
  if (!transport || !validBaseUrl(transport.baseUrl) || typeof transport.apiKey !== 'string' || !transport.apiKey || /\s/.test(transport.apiKey)) throw new AiError('ai_misconfigured', 503);
  return { name, ...transport };
}

/** Diagnostics use the same selection as calls; no network or credential output. */
export function aiDiagnostics(config = {}) {
  if (config.enabled !== true) return [];
  return [...new Set(['default', ...Object.keys(config.features ?? {})])].flatMap(feature => {
    try { selectTransport(config, feature); return []; }
    catch (error) { return [{ feature, code: error.code, message: error.message }]; }
  });
}
