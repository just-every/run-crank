import { terminalHelpHtml } from './terminal-guidance.mjs';

// Strip the fragment before exchanging either credential. Handle hash changes
// too, since a new link can target the already-open exchange page.
export const EXCHANGE_SCRIPT = `(() => {
  async function exchange() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const key = fragment.get('rer-dev'), signature = fragment.get('rer-persona');
    if (!key && !signature) return;
    history.replaceState(null, '', location.pathname + location.search);
    const as = fragment.get('as');
    const body = signature
      ? { persona: { signature, as, email: fragment.get('email'), expires: Number(fragment.get('expires')) } }
      : { key };
    const response = await fetch('/__dev/key', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!response.ok) {
      document.querySelector('main').insertAdjacentHTML('beforeend', ${JSON.stringify('<p role="alert">This link no longer opens the app. Run ~/.local/bin/rer dev again for a fresh one.</p>' + `<p>${terminalHelpHtml}</p>`)});
      return;
    }
    const next = signature ? (await response.json()).location : fragment.get('next') ||
      (as ? '/auth/dev/enter?as=' + encodeURIComponent(as) : location.pathname + location.search);
    location.replace(next.startsWith('/') && !next.startsWith('//') && !next.includes('\\\\') ? next : '/');
  }
  addEventListener('hashchange', exchange);
  exchange();
})()`;
