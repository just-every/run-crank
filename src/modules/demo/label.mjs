import { allow, sha256 } from '../operator-auth/csp.mjs';
import { NAVIGATION_SCRIPT, NAVIGATION_STYLE } from './navigation.mjs';

const escape = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

// CSS leaves React's text alone during hydration. The title observer handles
// client-side route changes, whose head manager writes a fresh title. The script
// is one constant text (so one constant CSP hash); the suffix reaches it as data
// on the label's style element, never as code.
const SCRIPT = "(()=>{const suffix=document.querySelector('style[data-rer-label]').dataset.rerLabel,update=()=>{const base=document.title.replace(/\\s*(?:Demo|Dev)$/,''),title=(base?base+' ':'')+suffix;if(document.title!==title)document.title=title};update();new MutationObserver(update).observe(document.head,{childList:true,subtree:true,characterData:true})})()";

export async function decorateLabel(response, mode, exit = import.meta.rerDemo) {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) return response;
  const suffix = mode === 'Demo' ? 'Demo' : 'Dev';
  const style = `[data-rer-name]::after{content:" ${suffix}"}${suffix === 'Demo' && exit ? NAVIGATION_STYLE : ''}`;
  const script = SCRIPT + ';' + (suffix === 'Demo' && exit ? NAVIGATION_SCRIPT : '');
  const html = await response.text();
  if (html.includes('data-rer-label=')) return new Response(html, response);
  const headers = new Headers(response.headers);
  let policy = headers.get('content-security-policy');
  if (policy) {
    policy = allow(policy, 'style-src', await sha256(style));
    headers.set('content-security-policy', allow(policy, 'script-src', await sha256(script)));
  }
  headers.delete('content-length');
  headers.delete('etag');
  const metadata = suffix === 'Demo' && exit ? ` data-rer-product="${escape(exit.name)}" data-rer-run="${escape(exit.url)}"` : '';
  const addition = `<style data-rer-label="${suffix}"${metadata}>${style}</style><script>${script}</script>`;
  const titled = html.replace(/(<title\b[^>]*>)([\s\S]*?)(<\/title>)/i, (_, open, title, close) => {
    const base = title.replace(/\s*(?:Demo|Dev)$/, '');
    return `${open}${base ? `${base} ` : ''}${suffix}${close}`;
  });
  const body = /<\/head\s*>/i.test(titled) ? titled.replace(/<\/head\s*>/i, () => `${addition}</head>`) : addition + titled;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
