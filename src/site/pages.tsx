// Static run site: marketing and repository guides never read installation data.
import { renderToStaticMarkup } from 'react-dom/server'
import { runPageHtml, siteNotFoundHtml, type RunData, type SiteBuild, type SiteContext } from '../base/run-site'
import { identity } from '../identity'
import run from './run.json'
import { Landing } from './landing/Landing'
import { DocsPage } from './docs/DocsPage'
import docsPages from 'virtual:crank-docs'

const escape = (value:string) => value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
function pageDocument(title:string,description:string,body:string,styles:string[],docs=false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><meta name="description" content="${escape(description)}"><link rel="icon" href="/brand/mark.svg"><link rel="stylesheet" href="/rer-theme.css">${styles.map(href=>`<link rel="stylesheet" href="${escape(href)}">`).join('')}${docs?'<link rel="stylesheet" href="/docs.css">':''}</head><body>${body}</body></html>`
}
export function sitePages({ styles=[] }: Partial<SiteContext> = {}): SiteBuild {
  const data: RunData = run
  return {
    pages: [
      { path: '/', html: pageDocument('Crank · You approve. Crank delivers.',identity.tagline,renderToStaticMarkup(<Landing variant="site" />),styles) },
      { path: '/run', html: runPageHtml(identity, data) },
      ...docsPages.map(page=>({path:page.slug?`/docs/${page.slug}`:'/docs',html:pageDocument(`${page.title} · Crank docs`,page.description,renderToStaticMarkup(<DocsPage page={page} pages={docsPages}/>),styles,true)})),
      { path: '/404', html: siteNotFoundHtml(identity, data) },
    ],
    assets: ['rer-theme.css', 'fonts', 'brand', 'docs.css', 'fixtures'],
  }
}
