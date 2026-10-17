// The pieces every section is made of. Text in the drawings is real text; the
// drawings are HTML and CSS (styles/cards.css), never screenshots.
import type { ReactNode } from 'react'

/** One idea per section: eyebrow, heading and a short paragraph beside its drawing. `flip` puts the drawing first. */
export function Feature({ id, eyebrow, title, children, art, flip = false, label }: { id: string; eyebrow: string; title: ReactNode; children: ReactNode; art: ReactNode; flip?: boolean; label: string }) {
  return <section id={id} className={`feature${flip ? ' flip' : ''}`} aria-labelledby={`${id}-title`}>
    <div className="site-wrap feature-row">
      <div className="feature-copy"><p className="eyebrow">{eyebrow}</p><h2 id={`${id}-title`}>{title}</h2><p className="feature-body">{children}</p></div>
      <div className="feature-art" role="img" aria-label={label}><div aria-hidden="true" className="feature-drawing">{art}</div></div>
    </div>
  </section>
}

/** A painted plate: AVIF, then WebP, at the sizes public/site holds; `phone` swaps in a crop on narrow screens. */
export function Painting({ name, widths, sizes, className, phone, eager = false }: { name: string; widths: number[]; sizes: string; className?: string; phone?: { name: string; widths: number[]; media: string }; eager?: boolean }) {
  const set = (n: string, ws: number[], ext: string) => ws.map(w => `/site/${n}-${w}.${ext} ${w}w`).join(', ')
  const largest = Math.max(...widths)
  return <picture className={className}>
    {phone && <source media={phone.media} type="image/avif" srcSet={set(phone.name, phone.widths, 'avif')} sizes="100vw" />}
    {phone && <source media={phone.media} type="image/webp" srcSet={set(phone.name, phone.widths, 'webp')} sizes="100vw" />}
    <source type="image/avif" srcSet={set(name, widths, 'avif')} sizes={sizes} />
    <img src={`/site/${name}-${largest}.webp`} srcSet={set(name, widths, 'webp')} sizes={sizes} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" fetchPriority={eager ? 'high' : undefined} />
  </picture>
}

export const Check = ({ className = 'check' }: { className?: string }) => <svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" /><path d="m7.2 12.4 3.2 3.2 6.4-6.8" /></svg>
export const Tick = () => <svg className="tick" viewBox="0 0 16 16"><path d="m3 8.5 3.2 3.2L13 4.8" /></svg>
export const Dot = ({ tone = 'green' }: { tone?: 'green' | 'blue' | 'amber' }) => <span className={`dot dot-${tone}`} />
export const ArrowRight = () => <svg className="arrow-right" viewBox="0 0 20 12"><path d="M1 6h17M13 1.5 18 6l-5 4.5" /></svg>
export const ArrowDown = () => <svg className="arrow-down" viewBox="0 0 12 40" preserveAspectRatio="none"><path d="M6 0v38M2 34l4 4 4-4" /></svg>

const PATHS: Record<string, ReactNode> = {
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></>,
  replay: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.5 3.8v3.4h3.4" /></>,
  code: <><path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5M13.5 5l-3 14" /></>,
  sparkle: <><path d="M12 3c.6 4.6 2.9 7.4 8 9-5.1 1.6-7.4 4.4-8 9-.6-4.6-2.9-7.4-8-9 5.1-1.6 7.4-4.4 8-9Z" /></>,
  warning: <><path d="M12 4 2.8 19.5h18.4Z" /><path d="M12 10v4.5M12 17.2v.3" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.6v.3" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.2v.3" /></>,
  minus: <><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>,
  monitor: <><rect x="3" y="4.5" width="18" height="12" rx="1.6" /><path d="M12 16.5v3.5M8 20h8" /></>,
  key: <><circle cx="15.5" cy="8.5" r="4.5" /><path d="M12.3 11.7 4 20M6.5 17.5l2.2 2.2M9 15l2 2" /><circle cx="16.4" cy="7.6" r="1" /></>,
  upload: <><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M4.5 14v5.5h15V14" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  bars: <><path d="M6 19v-4.5M12 19V10M18 19V5" /></>,
  history: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.5 3.8v3.4h3.4M12 8v4.3l3 1.8" /></>,
  people: <><circle cx="12" cy="8.5" r="3.2" /><path d="M6 19.5c.6-3.4 3-5.2 6-5.2s5.4 1.8 6 5.2" /><circle cx="5.2" cy="10" r="2.2" /><circle cx="18.8" cy="10" r="2.2" /><path d="M2 17.5c.3-2 1.5-3.2 3.2-3.4M22 17.5c-.3-2-1.5-3.2-3.2-3.4" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  doc: <><path d="M6.5 3h7.5l4 4v14h-11.5Z" /><path d="M14 3v4h4M9.5 12h5.5M9.5 15.5h5.5M9.5 9h2.5" /></>,
  mail: <><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="m3.8 6.8 8.2 6.2 8.2-6.2" /></>,
  grid: <><rect x="5" y="4" width="14" height="16" rx="1.5" /><path d="M5 9.5h14M5 14.5h14M12 9.5v10.5" /></>,
  dollar: <><path d="M12 4v16M16 7.5c-.7-1.4-2.2-2.2-4-2.2-2.4 0-4 1.3-4 3.1 0 4.2 8.2 2.4 8.2 6.9 0 1.9-1.8 3.3-4.2 3.3-2 0-3.6-.9-4.3-2.4" /></>,
}
export const Icon = ({ name, className = '' }: { name: keyof typeof PATHS | string; className?: string }) => <svg className={`icon ${className}`.trim()} viewBox="0 0 24 24">{PATHS[name]}</svg>

/** A third-party app in a drawing, as a plain tinted tile with a letter or a generic glyph (never its trademark). */
type App = 'stripe' | 'gmail' | 'slack' | 'sheets' | 'quickbooks' | 'salesforce' | 'hubspot' | 'typeform' | 'zapier' | 'n8n' | 'ai' | 'code'
const TILE: Record<App, ReactNode> = {
  stripe: 'S', gmail: <Icon name="mail" />, slack: '#', sheets: <Icon name="grid" />, quickbooks: 'QB', salesforce: 'SF',
  hubspot: 'H', typeform: 'T', zapier: 'Z', n8n: 'n8n', ai: <Icon name="sparkle" />, code: <Icon name="code" />,
}
export const AppTile = ({ app, className = '' }: { app: App; className?: string }) => <span className={`app app-${app} ${className}`.trim()}>{TILE[app]}</span>
