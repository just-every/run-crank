import { SiteFooter, SiteHeader } from '../landing/Landing'
import { docsPages } from './pages'
import type { DocsPageData } from './types'

type Props = { page: DocsPageData; pages?: DocsPageData[]; sourceHref?: string }

export function DocsPage({ page, pages = docsPages, sourceHref }: Props) {
  const navigation = pages.filter(entry => entry.slug)
  const sections = [...new Set(navigation.map(entry => entry.section))]
  const current = page.slug || 'getting-started'
  const index = navigation.findIndex(entry => entry.slug === current)
  const previous = navigation[index - 1], next = navigation[index + 1]
  return <div className="crank-landing crank-docs">
    <a className="docs-skip" href="#docs-content">Skip to documentation</a>
    <SiteHeader sourceHref={sourceHref} />
    <div className="docs-layout">
      <aside className="docs-sidebar" aria-label="Documentation navigation">
        <details className="docs-menu" open>
          <summary>Browse documentation <span aria-hidden="true">⌄</span></summary>
          <nav aria-label="Documentation pages">
            {sections.map(section => <div className="docs-nav-group" key={section}>
              <p className="docs-nav-label">{section}</p>
              <ul>{navigation.filter(entry => entry.section === section).map(entry => <li key={entry.slug}>
                <a href={`/docs/${entry.slug}`} aria-current={entry.slug === current ? 'page' : undefined}>{entry.title}</a>
              </li>)}</ul>
            </div>)}
            <a className="docs-run" href="/run">Run Crank <span aria-hidden="true">↗</span></a>
          </nav>
        </details>
      </aside>
      <main id="docs-content" className="docs-main" tabIndex={-1}>
        <p className="docs-eyebrow">Crank documentation <span aria-hidden="true">/</span> {page.section}</p>
        <article className="docs-prose" aria-label={page.title} dangerouslySetInnerHTML={{ __html: page.html }} />
        {(previous || next) && <nav className="docs-pager" aria-label="Reading order">
          {previous ? <a href={`/docs/${previous.slug}`}><span>← Previous</span><strong>{previous.title}</strong></a> : <span />}
          {next ? <a href={`/docs/${next.slug}`}><span>Next →</span><strong>{next.title}</strong></a> : <span />}
        </nav>}
      </main>
      {page.toc.length > 0 && <aside className="docs-contents" aria-label="On this page">
        <p className="docs-nav-label">On this page</p>
        <nav><ul>{page.toc.map(entry => <li key={entry.id} data-level={entry.level}><a href={`#${entry.id}`}>{entry.text}</a></li>)}</ul></nav>
      </aside>}
    </div>
    <SiteFooter sourceHref={sourceHref} />
  </div>
}
