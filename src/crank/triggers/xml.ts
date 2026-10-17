import { decodeEntities } from '../engine/transforms/html'
import { StepError } from '../engine/errors'

/** A small tolerant XML/HTML tree: no DTDs, no external entities, no scripts run. */
export interface XmlElement { type: 'element'; name: string; attrs: Record<string, string>; children: XmlNode[]; parent?: XmlElement }
export type XmlNode = XmlElement | { type: 'text'; text: string }
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

export function parseXml(source: string, { html = false, maxNodes = 200000 } = {}): XmlElement {
  const root: XmlElement = { type: 'element', name: '#document', attrs: {}, children: [] }
  let current = root, index = 0, nodes = 0
  const push = (node: XmlNode) => { if (++nodes > maxNodes) throw new StepError('provider', 'The document has too many nodes'); current.children.push(node) }
  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open < 0) { pushText(source.slice(index)); break }
    if (open > index) pushText(source.slice(index, open))
    if (source.startsWith('<!--', open)) { const end = source.indexOf('-->', open + 4); index = end < 0 ? source.length : end + 3; continue }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9)
      push({ type: 'text', text: source.slice(open + 9, end < 0 ? source.length : end) })
      index = end < 0 ? source.length : end + 3; continue
    }
    if (source.startsWith('<?', open) || source.startsWith('<!', open)) { const end = source.indexOf('>', open); index = end < 0 ? source.length : end + 1; continue }
    const end = findTagEnd(source, open)
    if (end < 0) { pushText(source.slice(open)); break }
    const tag = source.slice(open + 1, end)
    index = end + 1
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim().toLowerCase()
      let cursor: XmlElement | undefined = current
      while (cursor && cursor !== root && cursor.name.toLowerCase() !== name) cursor = cursor.parent
      if (cursor && cursor !== root) current = cursor.parent!
      continue
    }
    const selfClosing = tag.endsWith('/')
    const body = selfClosing ? tag.slice(0, -1) : tag
    const nameMatch = /^\s*([^\s/>]+)/.exec(body)
    if (!nameMatch) continue
    const element: XmlElement = { type: 'element', name: nameMatch[1], attrs: {}, children: [], parent: current }
    for (const attr of body.slice(nameMatch[0].length).matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      element.attrs[attr[1]] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? '')
    }
    push(element)
    const lower = element.name.toLowerCase()
    if (html && (lower === 'script' || lower === 'style')) {
      const close = source.toLowerCase().indexOf(`</${lower}`, index)
      index = close < 0 ? source.length : source.indexOf('>', close) + 1 || source.length
      continue
    }
    if (!selfClosing && !(html && VOID.has(lower))) current = element
  }
  return root
  function pushText(text: string) { if (text.trim() !== '') push({ type: 'text', text: decodeEntities(text) }) }
}
function findTagEnd(source: string, open: number) {
  let quote = ''
  for (let i = open + 1; i < source.length; i++) {
    const c = source[i]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

const local = (name: string) => name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
const nameMatches = (element: XmlElement, test: string) => test === '*' || element.name === test || (!test.includes(':') && local(element.name) === test) || element.name.toLowerCase() === test.toLowerCase()
export function textContent(node: XmlNode): string {
  return node.type === 'text' ? node.text : node.children.map(textContent).join('')
}
const elements = (node: XmlElement) => node.children.filter((child): child is XmlElement => child.type === 'element')
function descendants(node: XmlElement, out: XmlElement[] = []) {
  for (const child of elements(node)) { out.push(child); descendants(child, out) }
  return out
}
export const childNamed = (node: XmlElement, name: string) => elements(node).find(child => nameMatches(child, name))
export const childrenNamed = (node: XmlElement, name: string) => elements(node).filter(child => nameMatches(child, name))

/** XPath 1.0 location paths: `/` and `//` axes, name tests (prefix-insensitive) and `*`,
 * `.`, `..`, `@attr`, `text()`, and predicates `[n]`, `[last()]`, `[@a]`, `[@a='v']`,
 * `[child='v']`, `[contains(@a|text()|child,'v')]`, `[not(...)]`, joined by `and`/`or`. */
export function xpath(root: XmlElement, expression: string): (XmlElement | string)[] {
  const steps = splitSteps(expression.trim())
  let context: (XmlElement | string)[] = [root]
  for (const { axis, test } of steps) {
    const next: (XmlElement | string)[] = []
    for (const node of context) {
      if (typeof node === 'string') continue
      const pool = axis === '//' ? [node, ...descendants(node)] : [node]
      const { name, predicates } = parseStep(test)
      for (const base of pool) {
        if (name === '.') { if (axis !== '//' || base === node) next.push(base); continue }
        if (name === '..') { if (base.parent) next.push(base.parent); continue }
        if (name.startsWith('@')) { const value = base.attrs[name.slice(1)]; if (value !== undefined) next.push(value); continue }
        if (name === 'text()') { for (const child of base.children) if (child.type === 'text') next.push(child.text); continue }
        let matched = elements(base).filter(child => nameMatches(child, name))
        for (const predicate of predicates) matched = matched.filter((child, i) => predicateHolds(predicate, child, i, matched.length))
        next.push(...matched)
      }
    }
    context = [...new Set(next)]
  }
  return context
}
function splitSteps(expression: string) {
  if (!expression) throw new StepError('validation', 'XPath is empty')
  const steps: { axis: '/' | '//'; test: string }[] = []
  let i = 0
  while (i < expression.length) {
    let axis: '/' | '//'
    if (expression.startsWith('//', i)) { axis = '//'; i += 2 }
    else if (expression[i] === '/') { axis = '/'; i += 1 }
    else if (i === 0) axis = '//' // A relative path such as `item/title` matches anywhere below the document.
    else throw new StepError('validation', 'Invalid XPath')
    let depth = 0, quote = ''
    const start = i
    for (; i < expression.length; i++) {
      const c = expression[i]
      if (quote) { if (c === quote) quote = ''; continue }
      if (c === '"' || c === "'") quote = c
      else if (c === '[') depth++
      else if (c === ']') depth--
      else if (c === '/' && depth === 0) break
    }
    const test = expression.slice(start, i).trim()
    if (!test) throw new StepError('validation', 'Invalid XPath step')
    steps.push({ axis, test })
  }
  return steps
}
function parseStep(test: string) {
  const bracket = test.indexOf('[')
  const name = (bracket < 0 ? test : test.slice(0, bracket)).trim()
  const predicates: string[] = []
  let depth = 0, quote = '', start = -1
  for (let i = bracket < 0 ? test.length : bracket; i < test.length; i++) {
    const c = test[i]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '[') { if (depth++ === 0) start = i + 1 }
    else if (c === ']') { if (--depth === 0) predicates.push(test.slice(start, i).trim()) }
  }
  if (!name) throw new StepError('validation', 'Invalid XPath step')
  return { name, predicates }
}
function operand(node: XmlElement, ref: string): string | undefined {
  ref = ref.trim()
  if (ref.startsWith('@')) return node.attrs[ref.slice(1)]
  if (ref === 'text()' || ref === '.') return textContent(node).trim()
  const child = childNamed(node, ref)
  return child ? textContent(child).trim() : undefined
}
const literal = (text: string) => { const m = /^\s*(?:"([^"]*)"|'([^']*)')\s*$/.exec(text); if (!m) throw new StepError('validation', `XPath expected a quoted value, found ${text}`); return m[1] ?? m[2] }
function splitTop(text: string, word: string): string[] {
  const parts: string[] = []; let depth = 0, quote = '', start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (depth === 0 && text.startsWith(` ${word} `, i)) { parts.push(text.slice(start, i)); start = i + word.length + 2; i = start - 1 }
  }
  parts.push(text.slice(start))
  return parts
}
function predicateHolds(predicate: string, node: XmlElement, index: number, size: number): boolean {
  const ors = splitTop(predicate, 'or')
  if (ors.length > 1) return ors.some(part => predicateHolds(part, node, index, size))
  const ands = splitTop(predicate, 'and')
  if (ands.length > 1) return ands.every(part => predicateHolds(part, node, index, size))
  const p = predicate.trim()
  if (/^\d+$/.test(p)) return index === Number(p) - 1
  if (p === 'last()') return index === size - 1
  let m = /^not\((.*)\)$/.exec(p)
  if (m) return !predicateHolds(m[1], node, index, size)
  m = /^contains\(\s*([^,]+?)\s*,(.*)\)$/.exec(p)
  if (m) return (operand(node, m[1]) ?? '').includes(literal(m[2]))
  m = /^starts-with\(\s*([^,]+?)\s*,(.*)\)$/.exec(p)
  if (m) return (operand(node, m[1]) ?? '').startsWith(literal(m[2]))
  m = /^([^=!]+?)\s*(!?=)\s*(.+)$/.exec(p)
  if (m) { const value = operand(node, m[1]); return m[2] === '=' ? value === literal(m[3]) : value !== undefined && value !== literal(m[3]) }
  return operand(node, p) !== undefined
}

/** Element to mappable JSON: attributes as `@name`, text as `#text`, repeated children as lists. */
export function toJson(node: XmlElement | string): unknown {
  if (typeof node === 'string') return node
  const kids = elements(node), text = node.children.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('').trim()
  if (!kids.length && !Object.keys(node.attrs).length) return text
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node.attrs)) out['@' + key] = value
  for (const child of kids) {
    const key = child.name, value = toJson(child)
    out[key] = key in out ? [...(Array.isArray(out[key]) ? out[key] as unknown[] : [out[key]]), value] : value
  }
  if (text) out['#text'] = text
  return out
}
