// Runs after hydration and follows client navigation. Exits are out of flow:
// even a zero-width flex item would add a host gap and move its siblings.
export const NAVIGATION_SCRIPT = `(() => {
  const settings = document.querySelector('style[data-rer-label]');
  if (!settings.dataset.rerRun) return;
  const exits = new Map();
  let pending = false;
  const set = (element, values) => {
    for (const [key, value] of Object.entries(values)) {
      if (element.style[key] !== value) element.style[key] = value;
    }
  };
  const place = (link, x, y) => {
    const parent = link.offsetParent;
    if (!parent || (parent === document.body && getComputedStyle(parent).position === 'static')) {
      set(link, { left: x + scrollX + 'px', top: y + scrollY + 'px' });
      return;
    }
    const box = parent.getBoundingClientRect();
    const scaleX = box.width / parent.offsetWidth || 1;
    const scaleY = box.height / parent.offsetHeight || 1;
    set(link, {
      left: ((x - box.left) / scaleX - parent.clientLeft + parent.scrollLeft) + 'px',
      top: ((y - box.top) / scaleY - parent.clientTop + parent.scrollTop) + 'px'
    });
  };
  const fit = (position, link) => {
    if (link.matches(':popover-open')) return;
    const box = position.getBoundingClientRect();
    if (!position.getClientRects().length || !box.width || !box.height) {
      set(link, { display: 'none' });
      return;
    }
    set(link, { display: 'block' });
    const parent = position.parentElement;
    const layout = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    const rtl = layout.direction === 'rtl';
    const height = parseFloat(getComputedStyle(link).lineHeight);
    let top = box.top + (box.height - height) / 2;
    // Clip only our own allocation to the viewport and any clipping ancestors.
    let left = Math.max(0, bounds.left + parseFloat(layout.paddingLeft));
    let right = Math.min(document.documentElement.clientWidth, bounds.right - parseFloat(layout.paddingRight));
    let bottom = bounds.bottom - parseFloat(layout.paddingBottom);
    for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.overflowX !== 'visible') {
        const clip = ancestor.getBoundingClientRect();
        left = Math.max(left, clip.left + ancestor.clientLeft);
        right = Math.min(right, clip.left + ancestor.clientLeft + ancestor.clientWidth);
        bottom = Math.min(bottom, clip.top + ancestor.clientTop + ancestor.clientHeight);
      }
    }
    left = Math.min(document.documentElement.clientWidth, left);
    right = Math.max(left, right);
    const start = rtl ? box.left : box.right;
    const siblings = [...parent.children].filter(sibling => sibling !== position && !sibling.hasAttribute('data-rer-demo-exit'));
    const outerLeft = left, outerRight = right;
    for (const sibling of siblings) {
      const rect = sibling.getBoundingClientRect();
      if (!rect.width || rect.bottom <= top || rect.top >= top + height) continue;
      if (rtl && rect.left < start) left = Math.max(left, Math.min(start, rect.right));
      if (!rtl && rect.right > start) right = Math.min(right, Math.max(start, rect.left));
    }
    const range = document.createRange();
    range.selectNodeContents(link.firstElementChild);
    const natural = range.getBoundingClientRect().width;
    const gap = parseFloat(getComputedStyle(link).fontSize) / 2;
    const room = Math.max(0, (rtl ? start - left : right - start) - 2 * gap);
    let width = Math.min(natural, room);
    let x = Math.max(left, Math.min(right, rtl ? start - gap - width : start + gap));
    // A vertical rail may already have an empty row under the lockup. Use it
    // only if the whole exit fits there without touching any existing item.
    const below = box.bottom + gap;
    const belowX = rtl ? box.right - gap - natural : box.left + gap;
    if (width < natural && below + height <= bottom && belowX >= outerLeft && belowX + natural <= outerRight && siblings.every(sibling => {
      const rect = sibling.getBoundingClientRect();
      return !rect.width || rect.bottom <= below || rect.top >= below + height || rect.right <= belowX || rect.left >= belowX + natural;
    })) { width = natural; x = belowX; top = below; }
    // With no readable room, retain a keyboard stop, revealed in the top layer
    // on focus. Neither its box nor its focus ring can extend the document.
    const concealed = width < height;
    set(link, { width: (concealed ? 0 : width) + 'px', height: height + 'px', clipPath: concealed ? 'inset(50%)' : 'none' });
    place(link, x, top);
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; update(); });
  };
  const sizes = new ResizeObserver(schedule);
  const update = () => {
    for (const [position, link] of exits) {
      if (!position.isConnected || link.previousElementSibling !== position) {
        link.remove();
        exits.delete(position);
      }
    }
    for (const label of document.querySelectorAll('[data-rer-name]')) {
      const position = label.closest('a,button') ?? label;
      if (exits.has(position)) continue;
      const link = document.createElement('a');
      link.setAttribute('data-rer-demo-exit', '');
      link.setAttribute('popover', 'manual');
      link.href = settings.dataset.rerRun;
      link.title = link.ariaLabel = 'Run ' + settings.dataset.rerProduct;
      const text = document.createElement('span');
      text.textContent = link.title;
      link.append(text);
      // Own only the exit's box, including when a host styles all nav anchors.
      set(link, { position: 'absolute', display: 'block', boxSizing: 'border-box', margin: '0', padding: '0', border: '0', minWidth: '0', maxWidth: 'none', inset: 'auto', width: '0', overflow: 'visible', background: 'transparent' });
      link.addEventListener('focus', () => {
        if (!link.matches(':focus-visible')) return;
        link.showPopover();
        const box = position.getBoundingClientRect();
        set(link, { position: 'fixed', clipPath: 'none', width: 'max-content', maxWidth: 'calc(100vw - 16px)', height: 'auto', padding: '6px', background: 'Canvas', color: 'CanvasText' });
        const rect = link.getBoundingClientRect();
        set(link, { left: Math.max(8, Math.min(box.left, innerWidth - rect.width - 8)) + 'px', top: Math.max(8, Math.min(box.bottom + 4, innerHeight - rect.height - 8)) + 'px' });
      });
      link.addEventListener('blur', () => {
        if (!link.matches(':popover-open')) return;
        link.hidePopover();
        set(link, { position: 'absolute', maxWidth: 'none', padding: '0', background: 'transparent', color: '' });
        schedule();
      });
      position.after(link);
      exits.set(position, link);
      sizes.observe(position);
      sizes.observe(position.parentElement);
      for (const sibling of position.parentElement.children) if (sibling !== link) sizes.observe(sibling);
    }
    for (const [position, link] of exits) fit(position, link);
  };
  const start = () => {
    update();
    new MutationObserver(records => {
      if (records.some(record => !record.target.closest?.('[data-rer-demo-exit]'))) schedule();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    addEventListener('resize', schedule);
    addEventListener('scroll', schedule, true);
    document.fonts.addEventListener('loadingdone', schedule);
  };
  const ready = () => requestAnimationFrame(() => requestAnimationFrame(start));
  if (document.readyState === 'complete') ready();
  else addEventListener('load', ready, { once: true });
})()`;

export const NAVIGATION_STYLE = '[data-rer-demo-exit]{color:var(--rer-link,inherit);font:inherit;font-size:.8125rem;font-weight:400;line-height:1.5;white-space:nowrap;text-decoration:underline;text-underline-offset:3px}[data-rer-demo-exit]>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}[data-rer-demo-exit]:focus-visible{outline:2px solid var(--rer-focus,currentColor);outline-offset:-2px}';
