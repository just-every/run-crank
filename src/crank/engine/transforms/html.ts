const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}
const dropBlocks = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head|template)\b[\s\S]*?<\/\1\s*>/gi, '')
const attribute = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find(v => v !== undefined) ?? ''
const tidy = (text: string) => text.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()

/** Plain text that keeps line breaks and link text; scripts and styles are dropped. */
export function stripHtml(html: string): string {
  const text = dropBlocks(html)
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|table|ul|ol)\s*>/gi, '\n')
    .replace(/<(p|div|li|tr|h[1-6]|blockquote|ul|ol|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return tidy(decodeEntities(text))
}

export function htmlToMarkdown(html: string): string {
  let text = dropBlocks(html).replace(/\s+/g, ' ')
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => '\n```\n' + decodeEntities(body.replace(/<[^>]*>/g, '')) + '\n```\n')
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => `\n${'#'.repeat(Number(level))} ${body.trim()}\n`)
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, body) => { const href = attribute(attrs, 'href'); return href ? `[${body.trim()}](${href})` : body })
  text = text.replace(/<img\b([^>]*)>/gi, (_, attrs) => `![${attribute(attrs, 'alt')}](${attribute(attrs, 'src')})`)
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
  text = text.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '  \n')
  text = text.replace(/<\/(p|div|blockquote|ul|ol|table|tr)\s*>/gi, '\n\n').replace(/<[^>]*>/g, '')
  return tidy(decodeEntities(text))
}
