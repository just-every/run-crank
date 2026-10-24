// Runs after the app's initial hydration, then follows its client navigation.
// Each exit belongs beside an existing marked product label, never in a bar.
export const NAVIGATION_SCRIPT = `(() => {
  const settings = document.querySelector('style[data-rer-label]');
  if (!settings.dataset.rerRun) return;
  const update = () => {
    for (const label of document.querySelectorAll('[data-rer-name]')) {
      const position = label.closest('a,button') ?? label;
      if (position.nextElementSibling?.hasAttribute('data-rer-demo-exit')) continue;
      const link = document.createElement('a');
      link.setAttribute('data-rer-demo-exit', '');
      link.href = settings.dataset.rerRun;
      link.textContent = 'Run ' + settings.dataset.rerProduct;
      position.after(link);
      const layout = getComputedStyle(position.parentElement);
      if (label.scrollWidth > label.clientWidth && layout.display.includes('flex') && layout.flexWrap === 'nowrap') {
        link.style.width = 'min-content';
        link.style.whiteSpace = 'normal';
        link.style.textAlign = 'center';
        link.style.marginInlineStart = '0';
      }
    }
  };
  const start = () => {
    update();
    new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  };
  const ready = () => window.requestAnimationFrame(() => window.requestAnimationFrame(start));
  if (document.readyState === 'complete') ready();
  else window.addEventListener('load', ready, { once: true });
})()`;
export const NAVIGATION_STYLE = '[data-rer-demo-exit]{display:inline-block;flex-shrink:0;margin-inline-start:.5em;color:var(--rer-link,inherit);font:inherit;font-size:13px;font-weight:400;line-height:1.5;white-space:nowrap;text-decoration:underline;text-underline-offset:3px}[data-rer-demo-exit]:focus-visible{outline:2px solid var(--rer-focus,currentColor);outline-offset:3px}';
