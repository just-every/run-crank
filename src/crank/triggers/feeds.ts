import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { digest } from '../model'
import { childNamed, childrenNamed, parseXml, textContent, xpath, type XmlElement } from './xml'

/** One normalized feed item; `key` is its deduplication identity. */
export interface FeedItem {
  key: string; id: string | null; link: string | null; title: string | null; summary: string | null; content: string | null
  author: string | null; categories: string[]; published: string | null; updated: string | null
  enclosures: { url: string; type: string | null; length: number | null }[]; feed: { url: string; title: string | null; format: string }
}
const text = (node: XmlElement | undefined) => node ? textContent(node).trim() || null : null
const date = (value: string | null) => { if (!value) return null; const ms = Date.parse(value); return Number.isNaN(ms) ? value : new Date(ms).toISOString() }

/** GUID/id first, then the link, then a digest of title and date. */
async function identity(id: string | null, link: string | null, title: string | null, when: string | null) {
  if (id) return 'id:' + id
  if (link) return 'link:' + link
  return 'digest:' + await digest(JSON.stringify([title ?? '', when ?? '']))
}

export async function parseFeed(body: string, url: string, contentType: string | null): Promise<FeedItem[]> {
  const trimmed = body.trimStart()
  if (/json/.test(contentType ?? '') || trimmed.startsWith('{')) {
    let value: unknown
    try { value = JSON.parse(body) } catch { throw new StepError('provider', 'The feed is not valid JSON') }
    if (!isObject(value) || typeof value.version !== 'string' || !value.version.startsWith('https://jsonfeed.org/version/') || !Array.isArray(value.items)) throw new StepError('provider', 'The JSON document is not a JSON Feed')
    const feed = { url, title: typeof value.title === 'string' ? value.title : null, format: 'json_feed' }
    return Promise.all(value.items.filter(isObject).map(async item => {
      const str = (key: string) => typeof item[key] === 'string' ? item[key] as string : null
      const authors = Array.isArray(item.authors) ? item.authors : item.author ? [item.author] : []
      const id = item.id === undefined || item.id === null ? null : String(item.id)
      return {
        key: await identity(id, str('url'), str('title'), str('date_published')), id, link: str('url'), title: str('title'),
        summary: str('summary'), content: str('content_html') ?? str('content_text'),
        author: authors.filter(isObject).map(a => a.name).filter(Boolean).join(', ') || null,
        categories: Array.isArray(item.tags) ? item.tags.map(String) : [], published: date(str('date_published')), updated: date(str('date_modified')),
        enclosures: Array.isArray(item.attachments) ? item.attachments.filter(isObject).map(a => ({ url: String(a.url), type: typeof a.mime_type === 'string' ? a.mime_type : null, length: typeof a.size_in_bytes === 'number' ? a.size_in_bytes : null })) : [],
        feed,
      }
    }))
  }
  const root = parseXml(body)
  const rss = xpath(root, '/rss/channel').concat(xpath(root, '/rdf:RDF/channel')) as XmlElement[]
  if (rss.length) {
    const channel = rss[0] as XmlElement
    const feed = { url, title: text(childNamed(channel, 'title')), format: 'rss' }
    const items = (xpath(root, '/rss/channel/item').length ? xpath(root, '/rss/channel/item') : xpath(root, '//item')) as XmlElement[]
    return Promise.all(items.map(async item => {
      const guid = text(childNamed(item, 'guid')), link = text(childNamed(item, 'link')), title = text(childNamed(item, 'title')), published = text(childNamed(item, 'pubDate')) ?? text(childNamed(item, 'dc:date'))
      return {
        key: await identity(guid, link, title, published), id: guid, link, title, summary: text(childNamed(item, 'description')),
        content: text(childNamed(item, 'content:encoded')), author: text(childNamed(item, 'author')) ?? text(childNamed(item, 'dc:creator')),
        categories: childrenNamed(item, 'category').map(c => textContent(c).trim()).filter(Boolean), published: date(published), updated: null,
        enclosures: childrenNamed(item, 'enclosure').map(e => ({ url: e.attrs.url ?? '', type: e.attrs.type ?? null, length: e.attrs.length ? Number(e.attrs.length) : null })).filter(e => e.url),
        feed,
      }
    }))
  }
  const atom = xpath(root, '/feed') as XmlElement[]
  if (atom.length) {
    const feed = { url, title: text(childNamed(atom[0], 'title')), format: 'atom' }
    return Promise.all((xpath(root, '/feed/entry') as XmlElement[]).map(async entry => {
      const links = childrenNamed(entry, 'link')
      const alternate = links.find(l => !l.attrs.rel || l.attrs.rel === 'alternate')?.attrs.href ?? null
      const id = text(childNamed(entry, 'id')), title = text(childNamed(entry, 'title')), published = text(childNamed(entry, 'published')), updated = text(childNamed(entry, 'updated'))
      const author = childNamed(entry, 'author')
      return {
        key: await identity(id, alternate, title, published ?? updated), id, link: alternate, title, summary: text(childNamed(entry, 'summary')),
        content: text(childNamed(entry, 'content')), author: author ? text(childNamed(author, 'name')) : null,
        categories: childrenNamed(entry, 'category').map(c => c.attrs.term ?? textContent(c).trim()).filter(Boolean), published: date(published), updated: date(updated),
        enclosures: links.filter(l => l.attrs.rel === 'enclosure').map(l => ({ url: l.attrs.href ?? '', type: l.attrs.type ?? null, length: l.attrs.length ? Number(l.attrs.length) : null })).filter(e => e.url),
        feed,
      }
    }))
  }
  throw new StepError('provider', 'The document is not an RSS, Atom or JSON Feed')
}
