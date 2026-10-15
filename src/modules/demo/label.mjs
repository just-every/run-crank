import { allow, sha256 } from '../operator-auth/csp.mjs';

// CSS leaves React's text alone during hydration. The title observer handles
// client-side route changes, whose head manager writes a fresh title.
export async function decorateLabel(response, mode) {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) return response;
  const suffix = mode === 'Demo' ? 'Demo' : 'Dev';
  const style = `[data-rer-name]::after{content:" ${suffix}"}`;
  const script = `(()=>{const suffix=${JSON.stringify(suffix)},update=()=>{const title=document.title.replace(/ (?:Demo|Dev)$/,'')+' '+suffix;if(document.title!==title)document.title=title};update();new MutationObserver(update).observe(document.head,{childList:true,subtree:true,characterData:true})})()`;
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
  const addition = `<style data-rer-label="${suffix}">${style}</style><script>${script}</script>`;
  const titled = html.replace(/(<title\b[^>]*>)([\s\S]*?)(<\/title>)/i, (_, open, title, close) => `${open}${title.replace(/ (?:Demo|Dev)$/, '')} ${suffix}${close}`);
  const body = /<\/head\s*>/i.test(titled) ? titled.replace(/<\/head\s*>/i, `${addition}</head>`) : addition + titled;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
