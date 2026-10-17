import { links } from './links'

export const Arrow = () => <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 11h14.5M12.5 5.5 18 11l-5.5 5.5" /></svg>

/** The page's one action, Run Crank (the navy pill), then the demo and the docs as underlined text links. */
export function Actions({ demo = true }: { demo?: boolean }) {
  return <div className="site-actions">
    <a className="site-pill" href={links.run}>Run Crank<Arrow /></a>
    {demo && <a className="site-link" href={links.demo}>Try the demo</a>}
    <a className="site-link" href={links.docs}>Read the docs</a>
  </div>
}
