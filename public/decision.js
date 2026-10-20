// Approval requests are never queued or automatically sent again. An interrupted
// response leaves the visible proposal stale until a fresh server page is read.
const decisionPath = /^\/api\/crank\/(?:runs|workflow-runs)\/[^/]+\/(?:approve|reject)$/;
let pending = false;
let refreshing = false;
let sending = false;
let refreshUrl = location.href;

function decisionButtons() {
  return [...document.querySelectorAll('form[action="/app/action"]')].flatMap(form => {
    const hiddenPath = form.querySelector('input[name="path"]')?.value;
    return [...form.querySelectorAll('button')].filter(button => decisionPath.test(hiddenPath ?? button.value));
  });
}

function lock() {
  for (const button of decisionButtons()) button.disabled = true;
}

function notice(message, canRefresh = true) {
  let region = document.querySelector('[data-decision-status]');
  if (!region) {
    region = document.createElement('div');
    region.className = 'notice';
    region.dataset.decisionStatus = '';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.tabIndex = -1;
    document.querySelector('main')?.prepend(region);
  }
  const text = document.createElement('p');
  text.textContent = message;
  region.replaceChildren(text);
  if (canRefresh) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary';
    button.dataset.decisionRefresh = '';
    button.textContent = 'Check latest state';
    button.disabled = refreshing;
    region.append(button);
  }
  region.focus();
}

async function boundedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    // Read under the same deadline: losing the body is also an uncertain result.
    return { response, html: await response.text() };
  } finally { clearTimeout(timer); }
}

function showPage(response, html) {
  const url = new URL(response.url);
  if (url.origin !== location.origin || !/^\/app(?:\/|$)/.test(url.pathname)) {
    // Expired sessions return to native sign-in; no decision is repeated.
    location.assign(url.href);
    return false;
  }
  const page = new DOMParser().parseFromString(html, 'text/html');
  if (!response.ok || !page.querySelector('main.crank')) throw new Error('Latest state unavailable');
  document.title = page.title;
  document.body.replaceChildren(...page.body.childNodes);
  history.replaceState(null, '', url.href);
  document.dispatchEvent(new Event('crank:page'));
  refreshUrl = url.href;
  pending = false;
  return true;
}

async function reconcile(message = 'Latest state loaded. Review the current run state below.') {
  if (refreshing) return;
  refreshing = true;
  lock();
  notice('Checking the latest state. No decision is being sent.');
  try {
    const { response, html } = await boundedFetch(refreshUrl);
    if (showPage(response, html)) notice(message, false);
  } catch {
    pending = true;
    notice('Latest state is unavailable. The displayed proposal is stale. Reconnect and check the latest state before another decision.');
  } finally {
    refreshing = false;
    const button = document.querySelector('[data-decision-refresh]');
    if (button) button.disabled = false;
  }
}

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.getAttribute('action') !== '/app/action') return;
  const data = new FormData(form);
  if (event.submitter?.name) data.set(event.submitter.name, event.submitter.value);
  if (!decisionPath.test(String(data.get('path')))) return;
  event.preventDefault();
  if (pending) return;
  pending = true;
  refreshUrl = location.href;
  lock();
  if (!navigator.onLine) {
    notice('You are offline. This decision has not been sent. The displayed proposal is stale; reconnect and check its latest state.');
    return;
  }
  notice('Sending your decision. Waiting for the latest server state.', false);
  sending = true;
  try {
    const { response } = await boundedFetch(form.action, { method: 'POST', body: new URLSearchParams(data) });
    if (response.ok && response.redirected) refreshUrl = response.url;
    // Even a refusal may follow another person's decision. Read current state,
    // rather than allowing a second decision against the old proposal.
    await reconcile(response.ok ? 'Latest state loaded after your decision.' : 'The decision was refused. Latest state loaded; review the current proposal.');
  } catch {
    notice('The decision could not be confirmed. It may have reached the server. The displayed proposal is stale; check the latest state before another decision.');
  } finally { sending = false; }
});

document.addEventListener('click', event => {
  if (event.target instanceof Element && event.target.closest('[data-decision-refresh]')) reconcile();
});
window.addEventListener('online', () => { if (pending && !sending) reconcile(); });
window.addEventListener('pageshow', event => {
  if (event.persisted && decisionButtons().length) {
    pending = true;
    reconcile();
  }
});
