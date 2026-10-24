const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const quality = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/;

// Commas and semicolons inside quoted parameter values are not separators.
function split(value, separator) {
  const parts = [];
  let start = 0, quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === separator) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  return quoted || escaped ? null : [...parts, value.slice(start)];
}

function ranges(value) {
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return null;
  const members = split(value, ',');
  if (!members) return null;
  const result = [];
  for (const member of members) {
    if (!member.trim()) continue; // RFC 9110 list syntax permits empty members.
    const parts = split(member, ';');
    if (!parts) return null;
    const media = parts.shift().trim().toLowerCase().split('/');
    if (media.length !== 2 || !media.every(part => token.test(part)) || (media[0] === '*' && media[1] !== '*')) return null;
    const parameters = new Map();
    let q = 1, weighted = false;
    for (const part of parts) {
      if (!part.trim()) continue;
      const at = part.indexOf('='), name = part.slice(0, at).trim().toLowerCase(), raw = part.slice(at + 1).trim();
      if (at < 0 || !token.test(name)) return null;
      if (name === 'q') {
        if (weighted || !quality.test(raw)) return null;
        q = Number(raw); weighted = true;
      } else {
        if (parameters.has(name)) return null;
        const quoted = /^"(?:[\t !#-\[\]-~\u0080-\u00ff]|\\[\t\x20-\x7e\u0080-\u00ff])*"$/.test(raw);
        if (!token.test(raw) && !quoted) return null;
        parameters.set(name, quoted ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw);
      }
    }
    result.push({ media, parameters, q, order: result.length });
  }
  return result;
}

function preference(accepted, type, subtype) {
  let best = { q: 0, specificity: -1, parameters: -1, order: Infinity };
  for (const range of accepted) {
    if ((range.media[0] !== '*' && range.media[0] !== type) || (range.media[1] !== '*' && range.media[1] !== subtype)) continue;
    // Both responses are UTF-8; other media parameters are not supplied.
    if ([...range.parameters].some(([name, value]) => name !== 'charset' || value.toLowerCase() !== 'utf-8')) continue;
    const specificity = range.media[0] === '*' ? 0 : range.media[1] === '*' ? 1 : 2;
    const parameters = range.parameters.size;
    // Most specific matching range sets quality, including an explicit q=0.
    // Equally specific duplicate ranges use the first occurrence.
    if (specificity > best.specificity || (specificity === best.specificity && parameters > best.parameters)) {
      best = { q: range.q, specificity, parameters, order: range.order };
    }
  }
  return best;
}

/**
 * RFC 9110 Accept negotiation for the auth HTML/JSON surfaces. Equal quality
 * prefers specificity, then header order. No preference (absent or wildcard),
 * malformed fields, or no acceptable representation retain the non-HTML route
 * default. Request Content-Type never overrides the response preference.
 */
export function representation(request, routeDefault = 'json') {
  const accepted = ranges(request.headers.get('accept') ?? '');
  if (!accepted?.length) return routeDefault;
  const html = preference(accepted, 'text', 'html');
  const json = preference(accepted, 'application', 'json');
  if (!html.q) return html.specificity >= 0 || json.q ? 'json' : routeDefault;
  if (html.q !== json.q) return html.q > json.q ? 'html' : 'json';
  if (html.specificity !== json.specificity) return html.specificity > json.specificity ? 'html' : 'json';
  if (html.parameters !== json.parameters) return html.parameters > json.parameters ? 'html' : 'json';
  return html.order === json.order ? routeDefault : html.order < json.order ? 'html' : 'json';
}
