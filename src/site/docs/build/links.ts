import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, posix, relative, resolve } from 'node:path'

export type Anchor = { source: string; id: string }
export type LinkContext = { root: string; source: string; published: ReadonlyMap<string, string>; anchors: Anchor[] }
const repository = 'https://github.com/just-every/run-crank'
const fixture = 'public/fixtures/n8n-workflow.json'

export function rewriteLink(href: string, context: LinkContext): string {
  if (/[\u0000-\u001f\u007f\\]/.test(href)) throw new Error(`Invalid docs link: ${href}`)
  if (/^(https?:|mailto:)/i.test(href)) return href
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) throw new Error(`Unsupported docs link: ${href}`)
  const hashAt = href.indexOf('#')
  const rawPath = hashAt < 0 ? href : href.slice(0, hashAt)
  const hash = hashAt < 0 ? '' : href.slice(hashAt + 1)
  const id = decodeURIComponent(hash)
  if (hashAt >= 0 && !id) throw new Error(`Empty docs anchor: ${href}`)
  if (!rawPath) {
    if (!id) throw new Error('Empty docs link')
    context.anchors.push({ source: context.source, id })
    return href
  }
  if (rawPath.includes('?')) throw new Error(`Use a repository path without a query: ${href}`)
  const decoded = decodeURIComponent(rawPath)
  if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) throw new Error(`Invalid docs path: ${href}`)
  // Root docs URLs are allowed when they name an emitted page.
  if (decoded === '/docs' || decoded.startsWith('/docs/')) {
    const route = decoded.replace(/\/$/, '')
    const target = [...context.published].find(([, url]) => url === route || (route === '/docs' && url === '/docs/getting-started'))
    if (!target) throw new Error(`Missing docs page: ${href}`)
    if (id) context.anchors.push({ source: target[0], id })
    return route + (hash ? `#${hash}` : '')
  }
  const source = decoded.startsWith('/') ? decoded.slice(1) : posix.normalize(posix.join(posix.dirname(context.source), decoded))
  if (!source || source === '..' || source.startsWith('../') || isAbsolute(source)) throw new Error(`Docs link leaves the checkout: ${href}`)
  const file = resolve(context.root, source)
  if (!existsSync(file)) throw new Error(`Missing docs link target: ${source}`)
  const inside = relative(realpathSync(context.root), realpathSync(file))
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Docs link leaves the checkout: ${href}`)
  const suffix = hash ? `#${hash}` : ''
  if (id) {
    if (!source.endsWith('.md')) throw new Error(`Only Markdown links may name an anchor: ${href}`)
    context.anchors.push({ source, id })
  }
  const published = context.published.get(source)
  if (published) return published + suffix
  if (source === fixture) return '/fixtures/n8n-workflow.json'
  const kind = statSync(file).isDirectory() ? 'tree' : 'blob'
  return `${repository}/${kind}/main/${source.split('/').map(encodeURIComponent).join('/')}${suffix}`
}
