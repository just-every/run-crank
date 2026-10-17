// The pieces every section is made of. Text in the drawings is real text; the
// drawings are HTML and CSS (styles/cards.css and styles/sections/), never screenshots.
import type { ReactNode } from 'react'

/** A section's eyebrow, heading and short paragraph, in the hero's face (the page's type authority). */
export function SectionHead({ id, eyebrow, title, children, className = '' }: { id: string; eyebrow: string; title: ReactNode; children?: ReactNode; className?: string }) {
  return <div className={`sec-head ${className}`.trim()}>
    <p className="kicker">{eyebrow}</p>
    <h2 id={`${id}-title`}>{title}</h2>
    {children && <p className="sec-body">{children}</p>}
  </div>
}

/** A painted plate: AVIF, then WebP, at the sizes public/site holds; `phone` swaps in its own plate on narrow screens. */
export function Painting({ name, widths, sizes, className, phone, eager = false }: { name: string; widths: number[]; sizes: string; className?: string; phone?: { name: string; widths: number[]; media: string; sizes?: string }; eager?: boolean }) {
  const set = (n: string, ws: number[], ext: string) => ws.map(w => `/site/${n}-${w}.${ext} ${w}w`).join(', ')
  const fallback = widths.includes(1536) ? 1536 : Math.max(...widths)
  return <picture className={className}>
    {phone && <source media={phone.media} type="image/avif" srcSet={set(phone.name, phone.widths, 'avif')} sizes={phone.sizes ?? '100vw'} />}
    {phone && <source media={phone.media} type="image/webp" srcSet={set(phone.name, phone.widths, 'webp')} sizes={phone.sizes ?? '100vw'} />}
    <source type="image/avif" srcSet={set(name, widths, 'avif')} sizes={sizes} />
    <img src={`/site/${name}-${fallback}.webp`} srcSet={set(name, widths, 'webp')} sizes={sizes} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" fetchPriority={eager ? 'high' : undefined} />
  </picture>
}

/** Crank's approved smiling-gear mark (public/brand/mark.svg), as the avatar wherever Crank speaks. */
export const Mark = ({ className = 'mark' }: { className?: string }) => <span className={className}><img src="/brand/mark.svg" alt="" width="40" height="40" /></span>

/** Joins each " · " to its neighbours and each " → " to the word before it with no-break spaces, so a
 *  separator never starts or ends a wrapped line and an arrow never starts one. */
export const glued = (text: string) => text.replaceAll(' · ', '\u00a0·\u00a0').replaceAll(' → ', '\u00a0→ ')

export const Check = ({ className = 'check' }: { className?: string }) => <svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" /><path d="m7.2 12.4 3.2 3.2 6.4-6.8" /></svg>
export const Cross = () => <svg className="cross" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" /><path d="m8.2 8.2 7.6 7.6M15.8 8.2l-7.6 7.6" /></svg>
export const Dot = ({ tone = 'green' }: { tone?: 'green' | 'red' | 'amber' }) => <span className={`dot dot-${tone}`} />

const PATHS: Record<string, ReactNode> = {
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></>,
  replay: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.5 3.8v3.4h3.4" /></>,
  sparkle: <><path d="M12 3c.6 4.6 2.9 7.4 8 9-5.1 1.6-7.4 4.4-8 9-.6-4.6-2.9-7.4-8-9 5.1-1.6 7.4-4.4 8-9Z" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.2v.3" /></>,
  minus: <><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>,
  mail: <><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="m3.8 6.8 8.2 6.2 8.2-6.2" /></>,
  grid: <><rect x="5" y="4" width="14" height="16" rx="1.5" /><path d="M5 9.5h14M5 14.5h14M12 9.5v10.5" /></>,
  bag: <><path d="M5.5 8h13l-1 12h-11Z" /><path d="M9 10V7a3 3 0 0 1 6 0v3" /></>,
  webhook: <><circle cx="12" cy="6.5" r="2.6" /><circle cx="5.8" cy="17" r="2.6" /><circle cx="18.2" cy="17" r="2.6" /><path d="M10.7 8.8 7.2 14.8M8.4 17h7.2M13.3 8.8l3.5 6" /></>,
  book: <><path d="M12 6.5c-2-1.5-5-2-8-1.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5Z" /><path d="M12 6.5V20" /></>,
  pencil: <><path d="m4 20 1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5Z" /><path d="m13.5 7 3 3" /></>,
  moon: <><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z" /></>,
}
export const Icon = ({ name, className = '' }: { name: keyof typeof PATHS | string; className?: string }) => <svg className={`icon ${className}`.trim()} viewBox="0 0 24 24">{PATHS[name]}</svg>

/** A third-party app in a drawing, as a plain tinted tile with a letter or a generic glyph (never its trademark). */
export type App = 'stripe' | 'gmail' | 'slack' | 'sheets' | 'quickbooks' | 'shopify' | 'hubspot' | 'typeform' | 'zendesk' | 'webhook' | 'schedule' | 'ai'
const TILE: Record<App, ReactNode> = {
  stripe: 'S', gmail: <Icon name="mail" />, slack: '#', sheets: <Icon name="grid" />, quickbooks: 'QB', shopify: <Icon name="bag" />,
  hubspot: 'H', typeform: 'T', zendesk: 'Z', webhook: <Icon name="webhook" />, schedule: <Icon name="clock" />, ai: <Icon name="sparkle" />,
}
export const AppTile = ({ app, className = '' }: { app: App; className?: string }) => <span className={`app app-${app} ${className}`.trim()}>{TILE[app]}</span>
