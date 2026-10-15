import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { DocsPageMeta } from '../types'

export const manifestFile = 'docs/site.json'

/** Resolve only real files inside this checkout, including when a path is a symlink. */
export function sourceFile(root: string, source: string): string {
  if (isAbsolute(source) || source.includes('\\') || source.split('/').includes('..')) throw new Error(`Invalid docs source: ${source}`)
  const file = realpathSync(resolve(root, source))
  const path = relative(realpathSync(root), file)
  if (path.startsWith('..') || isAbsolute(path) || !statSync(file).isFile()) throw new Error(`Docs source is not a checkout file: ${source}`)
  return file
}

export function readManifest(root: string): DocsPageMeta[] {
  const manifest = JSON.parse(readFileSync(resolve(root, manifestFile), 'utf8'))
  if (!Array.isArray(manifest.sections) || !manifest.sections.length) throw new Error('docs/site.json needs sections')
  const slugs = new Set<string>(), sources = new Set<string>()
  return manifest.sections.flatMap((section: Record<string, unknown>) => {
    if (typeof section.title !== 'string' || !section.title.trim() || !Array.isArray(section.pages) || !section.pages.length) throw new Error('Each docs section needs a title and pages')
    return section.pages.map((entry: Record<string, unknown>) => {
      const { slug, source, title, description } = entry
      if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug === 'index' || slugs.has(slug)) throw new Error(`Invalid or repeated docs slug: ${String(slug)}`)
      if (typeof source !== 'string' || !source.endsWith('.md') || sources.has(source)) throw new Error(`Invalid or repeated docs source: ${String(source)}`)
      if (typeof title !== 'string' || !title.trim() || typeof description !== 'string' || !description.trim()) throw new Error(`Docs page ${slug} needs a title and description`)
      sourceFile(root, source)
      slugs.add(slug); sources.add(source)
      return { slug, source, title, description, section: section.title as string }
    })
  })
}
