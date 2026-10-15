import { Marked } from 'marked'
import type { DocsTocEntry } from '../types'
import { rewriteLink, type Anchor, type LinkContext } from './links'
import { escapeHtml, headingText, slugger } from './slug'

export type Rendered = { html: string; toc: DocsTocEntry[]; ids: Set<string>; anchors: Anchor[]; title: string }

export function renderMarkdown(markdown: string, context: Omit<LinkContext, 'anchors'>): Rendered {
  const slug = slugger(), ids = new Set<string>(), toc: DocsTocEntry[] = [], anchors: Anchor[] = []
  let title = '', titles = 0
  const parser = new Marked({ gfm: true, renderer: {
    heading({ tokens, depth }) {
      const text = headingText(this.parser.parseInline(tokens, this.parser.textRenderer))
      const id = slug(text)
      ids.add(id)
      if (depth === 1) { title = text; titles++ }
      if (depth === 2 || depth === 3) toc.push({ id, text, level: depth })
      return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`
    },
    code({ text, lang }) {
      const language = (lang ?? '').trim().split(/\s+/)[0]
      const label = /^(sh|bash|shell|zsh)$/.test(language) ? 'Shell' : language.toUpperCase() || 'Code'
      return `<div class="docs-code"><div class="docs-code-label">${escapeHtml(label)}</div><pre tabindex="0" aria-label="${escapeHtml(label)} code"><code>${escapeHtml(text)}</code></pre></div>\n`
    },
    html({ text }) { return escapeHtml(text) },
    link({ href, title: label, tokens }) {
      const target = rewriteLink(href, { ...context, anchors })
      return `<a href="${escapeHtml(target)}"${label ? ` title="${escapeHtml(label)}"` : ''}>${this.parser.parseInline(tokens)}</a>`
    },
    image() { throw new Error('Docs images need an explicit local asset declaration') },
  } })
  const html = (parser.parse(markdown, { async: false }) as string)
    .replace(/<table>/g, '<div class="docs-table" role="region" tabindex="0" aria-label="Reference table"><table>')
    .replace(/<\/table>/g, '</table></div>')
  if (titles !== 1) throw new Error('Each docs page needs exactly one level-one title')
  return { html, toc, ids, anchors, title }
}

/** Unpublished repository documents still supply real heading targets for GitHub links. */
export function headingIds(markdown: string): Set<string> {
  const slug = slugger(), ids = new Set<string>()
  const parser = new Marked({ renderer: { heading({ tokens }) {
    ids.add(slug(headingText(this.parser.parseInline(tokens, this.parser.textRenderer))))
    return ''
  } } })
  parser.parse(markdown, { async: false })
  return ids
}
