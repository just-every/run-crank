import { docsPages as pages } from 'virtual:crank-docs'
import type { DocsPageData } from './types'

// The published docs, parsed from docs/site.json and rendered at build time (build/plugin.ts), and lookups over them.

export const docsPages: DocsPageData[] = pages
export const docsSections = [...new Set(pages.map(page => page.section))].map(title => ({ title, pages: pages.filter(page => page.section === title) }))
export const docsLead = 'Start Crank on your own computer, connect your apps, run workflows with the approvals you choose, and keep your data.'

export const getDocsPage = (slug: string) => pages.find(page => page.slug === slug)

/** The pages before and after `slug` in reading order, across sections. */
export function docsNeighbours(slug: string): { previous?: DocsPageData; next?: DocsPageData } {
  const index = pages.findIndex(page => page.slug === slug)
  return index === -1 ? {} : { previous: pages[index - 1], next: pages[index + 1] }
}

/** Document title and description: the docs home without a slug, a page with one. */
export function docsHead(slug?: string): { title: string; description: string } {
  const page = slug === undefined ? undefined : getDocsPage(slug)
  return page ? { title: `${page.title} · Crank docs`, description: page.description } : { title: 'Docs · Crank', description: docsLead }
}
