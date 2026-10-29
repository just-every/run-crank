import { Arrow } from '../shell/Actions'
import { SiteFooter } from '../shell/SiteFooter'
import { SiteHeader } from '../shell/SiteHeader'
import { docsPath, links } from '../shell/links'
import { docsLead, docsSections } from './pages'
import { TitleDots } from './TitleDots'
import '../styles/site.css'
import '../styles/docs.css'

/** The docs home: every section as a row of white cards, each page's title over its one-line summary. */
export function DocsIndex() {
  return <>
    <SiteHeader current="docs" />
    <div className="docs-page"><main id="main" className="site-wrap docs-home">
      <header className="docs-home-head"><p className="eyebrow">Crank</p><h1>Docs</h1><TitleDots /><p className="docs-summary">{docsLead} New here? <a href={links.run}>Run Crank</a> first. Ready to put it online? Read the <a href="/docs/hosting">hosting guide</a>.</p></header>
      {docsSections.map((section, index) => <section key={section.title} aria-labelledby={`docs-section-${index}`} className="docs-home-section">
        <h2 id={`docs-section-${index}`}>{section.title}</h2>
        <ul className="docs-cards">{section.pages.map(page => <li key={page.slug}><a className="docs-card" href={docsPath(page.slug)}><span className="docs-card-title">{page.title}</span><span className="docs-card-summary">{page.description}</span><Arrow /></a></li>)}</ul>
      </section>)}
    </main></div>
    <SiteFooter />
  </>
}
