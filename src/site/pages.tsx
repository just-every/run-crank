// The run site (run-crank.com) `rer build --site` writes: the homepage with its
// Run action, /run, the docs from docs/*.md, and the not-found page. Every Run
// page string and command is in run.json; nothing here reads installation data.
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runPageHtml, siteNotFoundHtml, type RunData, type SiteBuild, type SiteContext } from '../base/run-site'
import { identity } from '../identity'
import { DocsArticle } from './docs/DocsArticle'
import { DocsIndex } from './docs/DocsIndex'
import { docsHead, docsPages } from './docs/pages'
import { Landing } from './landing/Landing'
import run from './run.json'

// Code cards get their Copy button only when script runs; without it the command is still there to select.
const COPY = "document.querySelectorAll('.docs-copy').forEach(b=>{b.hidden=false;b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(b.closest('.docs-code').querySelector('code').textContent);b.textContent='Copied';setTimeout(()=>{b.textContent='Copy'},1600)}catch{}})})"

const SHARE_IMAGE = `${identity.runSite}/site/share.jpg`

export function sitePages({ styles }: SiteContext): SiteBuild {
  const data: RunData = run
  const document = (title: string, description: string, body: ReactElement, script = '') => '<!doctype html>' + renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta name="theme-color" content="#f3f8fd" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Crank" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:image" content={SHARE_IMAGE} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" type="image/svg+xml" href="/brand/favicon-32.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="preload" href="/fonts/figtree/figtree-latin-wght-normal.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="stylesheet" href="/fonts/fonts.css" />
        <link rel="stylesheet" href={identity.theme} />
        {styles.map(href => <link key={href} rel="stylesheet" href={href} />)}
      </head>
      <body>{body}{script ? <script dangerouslySetInnerHTML={{ __html: script }} /> : null}</body>
    </html>,
  )
  const head = (slug?: string) => { const { title, description } = docsHead(slug); return [title, description] as const }
  return {
    pages: [
      { path: '/', html: document('Crank · The busywork runs itself.', identity.tagline, <Landing />) },
      { path: '/run', html: runPageHtml(identity, data) },
      { path: '/docs', html: document(...head(), <DocsIndex />) },
      ...docsPages.map(page => ({ path: `/docs/${page.slug}`, html: document(...head(page.slug), <DocsArticle slug={page.slug} />, COPY) })),
      { path: '/404', html: siteNotFoundHtml(identity, data) },
    ],
    assets: ['rer-theme.css', 'fonts', 'brand', 'site', 'fixtures', 'favicon.ico', 'apple-touch-icon.png'],
  }
}
