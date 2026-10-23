import { iconHead } from './icon-head.mjs';
import { accentInk } from './branding.mjs';
import { escapeHtml, securityHeaders } from './http.mjs';

// The shared frame of every server-rendered auth page (confirmation, sign-in):
// no script, styles allowed only by their own hash, the seed's theme when it
// declares one, light and dark.
// Added only when the seed declares a theme: its linked rer-theme.css supplies
// the --rer-* tokens; --rer-logo toggles and draws the mark beside the name.
// Each token falls back to a readable neutral if the file cannot load.
function themed(accentColor) {
  return `.rer-themed{color-scheme:light;background:var(--rer-page,#f3f5f8);color:var(--rer-text,#172033)}.rer-themed body{font-family:var(--rer-font-body,inherit)}.rer-themed main{background:var(--rer-surface,#fff);border-color:transparent;border-radius:var(--rer-radius,20px);box-shadow:0 1px 2px #0000000d,0 14px 36px #00000014}.rer-themed h1{font-family:var(--rer-font-heading,var(--rer-font-body,inherit))}.rer-themed .brand{display:flex;align-items:center;gap:12px;font-size:16px;color:var(--rer-text,#172033);font-family:var(--rer-font-heading,var(--rer-font-body,inherit))}.rer-themed .mark{display:none}.rer-themed .brand::before{content:var(--rer-logo,none);display:block;flex:none;width:32px;height:32px;overflow:hidden;text-indent:200%;white-space:nowrap;background:var(--rer-logo) center/contain no-repeat}.rer-themed p{color:var(--rer-muted,#475569)}.rer-themed button,.rer-themed .action{border-color:transparent;border-radius:var(--rer-radius,10px);background:var(--rer-accent,${accentColor});color:var(--rer-accent-text,${accentInk(accentColor)})}.rer-themed button:focus-visible,.rer-themed .action:focus-visible{outline-color:var(--rer-focus,#172033)}.rer-themed button.secondary{background:transparent;color:var(--rer-text,#172033);border-color:var(--rer-muted,#64748b)}.rer-themed .secondary-link a{color:var(--rer-link,var(--rer-text,#172033))}.rer-themed .secondary-link a:focus-visible{outline-color:var(--rer-focus,#172033)}`;
}

function stylesheet(accentColor) {
  return `:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f3f5f8}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:32px 20px;display:grid;place-items:center}main{width:100%;max-width:480px;background:#fff;border:1px solid #dce2ea;border-radius:20px;padding:36px;box-shadow:0 12px 40px #1720330a;overflow-wrap:anywhere}.brand{font-size:14px;font-weight:650;line-height:1.5;margin:0 0 32px;color:#475569}.mark{display:block;width:32px;height:6px;border-radius:3px;border:1px solid currentColor;background:${accentColor};margin-bottom:16px}h1,h2{text-wrap:balance}h1{font-size:30px;line-height:1.3;letter-spacing:-.02em;margin:0 0 24px;font-weight:700}p{font-size:16px;line-height:1.6;margin:0 0 24px;color:#475569;text-wrap:pretty}form{margin:0}button,.action{display:block;width:100%;border:1px solid #64748b;border-radius:10px;background:${accentColor};color:${accentInk(accentColor)};padding:13px 18px;font:inherit;font-weight:650;text-align:center;text-decoration:none;cursor:pointer;line-height:1.5}button:hover,.action:hover{box-shadow:inset 0 0 0 2px currentColor}button:focus-visible,.action:focus-visible{outline:3px solid #172033;outline-offset:4px}@media(max-width:480px){body{padding:24px 16px}main{padding:28px 24px}h1{font-size:28px}}@media(prefers-color-scheme:dark){:root{color-scheme:dark;background:#111827;color:#f8fafc}main{background:#1e293b;border-color:#475569;box-shadow:none}.brand,p{color:#cbd5e1}button:focus-visible,.action:focus-visible{outline-color:#f8fafc}}`;
}

// Form controls and notices used by the sign-in and settings pages; part of the same hashed sheet.
const FORMS = `label{display:block;font-weight:600;margin:0 0 8px}input{display:block;width:100%;margin:0 0 16px;padding:12px 14px;border:1px solid #64748b;border-radius:10px;font:inherit;line-height:1.5;color:inherit;background:transparent}input:focus-visible{outline:3px solid #172033;outline-offset:2px}.stack{display:grid;gap:12px;margin:0 0 24px}.check{display:flex;align-items:center;gap:12px;margin:0 0 24px}.check input{width:20px;height:20px;margin:0;padding:0;flex:none}button.secondary{background:transparent;color:inherit}.divider{display:flex;align-items:center;gap:12px;margin:0 0 24px;color:#475569;font-size:14px}.divider::before,.divider::after{content:"";flex:1;border-top:1px solid #dce2ea}.notice{border-left:4px solid #64748b;padding:8px 12px;margin:0 0 24px}h2{font-size:20px;line-height:1.4;margin:32px 0 16px}.secondary-link{margin:16px 0 0;text-align:center;font-size:15px}.secondary-link a{display:inline-block;min-width:24px;min-height:24px;color:#334155;font-weight:600;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}.secondary-link a:hover{text-decoration-thickness:2px}.secondary-link a:focus-visible{outline:3px solid #172033;outline-offset:2px;border-radius:2px}@media(prefers-color-scheme:dark){input:focus-visible,.secondary-link a:focus-visible{outline-color:#f8fafc}.divider{color:#cbd5e1}.divider::before,.divider::after{border-color:#475569}.secondary-link a{color:#cbd5e1}}`;

export async function pageResponse({ branding, title, heading, content, status = 200, method = 'GET', referrer, formTargets = [] }) {
  const css = stylesheet(branding.accentColor) + FORMS + (branding.theme ? themed(branding.accentColor) : '')
    + (branding.mark ? '.brand{display:flex;align-items:center;gap:12px}.brand img{display:block;flex:none;width:32px;height:32px;object-fit:contain}.rer-themed .brand::before,.brand::before{display:none}' : '');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(css)));
  const hash = btoa(String.fromCharCode(...digest));
  const product = escapeHtml(branding.productName);
  const mark = branding.mark ? `<img src="${escapeHtml(branding.mark)}" alt="${product}" width="32" height="32" decoding="async">` : '<span class="mark" aria-hidden="true"></span>';
  const html = `<!doctype html><html lang="en"${branding.theme ? ' class="rer-themed"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title ?? heading}</title>${iconHead}${branding.theme ? `<link rel="stylesheet" href="${escapeHtml(branding.theme)}">` : ''}<style>${css}</style></head><body><main><p class="brand">${mark}<span data-rer-name>${product}</span></p><h1>${heading}</h1>${content}</main></body></html>`;
  const headers = { ...securityHeaders(), 'Content-Type': 'text/html; charset=utf-8' };
  // A form may post to this origin only, plus any origin its own redirect must reach (a provider's authorization endpoint).
  if (formTargets.length) headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace("form-action 'self'", `form-action 'self' ${formTargets.join(' ')}`);
  headers['Content-Security-Policy'] += branding.theme ? `; style-src 'self' 'sha256-${hash}'; font-src 'self'; img-src 'self'` : `; style-src 'sha256-${hash}'`;
  if ((iconHead || branding.mark) && !branding.theme) headers['Content-Security-Policy'] += "; img-src 'self'";
  // Native form POSTs need their Origin; never disclose the path or query.
  if (referrer) headers['Referrer-Policy'] = referrer;
  return new Response(method === 'HEAD' ? null : html, { status, headers });
}
