import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DocsPageData } from '../types'
import { manifestFile, readManifest, sourceFile } from './manifest'
import { headingIds, renderMarkdown } from './render'

export function buildDocs(root: string): { pages: DocsPageData[]; files: string[] } {
  const meta = readManifest(root)
  const published = new Map(meta.map(page => [page.source, `/docs/${page.slug}`]))
  const files = new Set([resolve(root, manifestFile)])
  const read = (source: string) => {
    const file = sourceFile(root, source)
    files.add(file)
    return readFileSync(file, 'utf8')
  }
  const rendered = new Map(meta.map(page => {
    try { return [page.source, renderMarkdown(read(page.source), { root, source: page.source, published })] as const }
    catch (error) { throw new Error(`${page.source}: ${(error as Error).message}`) }
  }))
  const ids = new Map([...rendered].map(([source, page]) => [source, page.ids]))
  for (const [source, page] of rendered) {
    for (const anchor of page.anchors) {
      if (!ids.has(anchor.source)) ids.set(anchor.source, headingIds(read(anchor.source)))
      if (!ids.get(anchor.source)!.has(anchor.id)) throw new Error(`${source}: missing heading ${anchor.source}#${anchor.id}`)
    }
  }
  // The page head (section, title, summary) is drawn by DocsArticle, so the Markdown's own title is left out of the body.
  const pages = meta.map(({ slug, title, description, section, source }) => {
    const page = rendered.get(source)!
    if (page.title !== title) throw new Error(`${source}: docs/site.json title must match its Markdown title`)
    return { slug, title, description, section, html: page.html.replace(/^<h1 [^>]*>.*?<\/h1>\n/, ''), toc: page.toc }
  })
  return { pages, files: [...files] }
}
