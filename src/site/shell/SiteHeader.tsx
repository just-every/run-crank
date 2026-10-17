import { links } from './links'

/** The header on every run-site page: the lockup (mark and "Crank" in the heading face) and Docs, Contract and Source.
 * `overArt` lays it over the homepage's painted sky. */
export function SiteHeader({ current, overArt = false }: { current?: 'docs'; overArt?: boolean }) {
  return <header className={`site-header${overArt ? ' over-art' : ''}`}>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="site-wrap"><div className="site-header-row">
      <a className="site-brand" href={links.home}><img src="/brand/mark.svg" alt="" width="40" height="40" /><span>Crank</span></a>
      <nav aria-label="Main">
        <a href={links.docs} aria-current={current === 'docs' ? 'page' : undefined}>Docs</a>
        <a href={links.contract}>Contract</a>
        <a href={links.source}>Source</a>
      </nav>
    </div></div>
  </header>
}
