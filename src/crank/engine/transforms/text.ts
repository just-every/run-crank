import { marked } from 'marked'
import { parseDecimal, toJson } from '../decimal'
import { StepError } from '../errors'
import { choice, integer, text, type Args, type Transform } from './args'
import { htmlToMarkdown, stripHtml } from './html'

const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/gi
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d{8,15}\b/g
const NUMBER = /[-+]?\(?[$€£]?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|[-+]?[$€£]?\d*\.?\d+/g

/** E.164 with a US default region; other regions need an explicit + country code. */
export function e164(raw: string, region = 'US'): string | null {
  const digits = raw.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null
  if (region !== 'US') return null
  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return '+1' + digits
  if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return '+' + digits
  return null
}
function extract(args: Args, pattern: RegExp, label: string, normalize: (match: string) => unknown = match => match) {
  const matches = [...text(args).matchAll(pattern)].map(match => normalize(match[0])).filter(value => value !== null)
  if (args.all === true) return matches
  if (!matches.length) {
    if (args.if_none === 'null') return null
    throw new StepError('validation', `No ${label} found in the text`)
  }
  return matches[0]
}
function titleCase(value: string) { return value.toLowerCase().replace(/(^|[\s\-'’(])(\p{L})/gu, (_, lead, letter) => lead + letter.toUpperCase()) }
function sentenceCase(value: string) { return value.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_, lead, letter) => lead + letter.toUpperCase()) }

export const textTransforms: Record<string, Transform> = {
  'text.split': args => {
    const value = text(args), rule = choice(args, 'rule', ['separator', 'first_word', 'last_word'] as const, 'separator')
    if (rule !== 'separator') {
      const words = value.trim().split(/\s+/).filter(Boolean)
      if (!words.length) throw new StepError('validation', 'There is no text to split')
      return rule === 'first_word' ? { first: words[0], last: words.slice(1).join(' ') } : { first: words.slice(0, -1).join(' '), last: words.at(-1) }
    }
    const separator = args.separator === undefined ? ' ' : text(args, 'separator')
    const parts = value.split(separator === '' ? /\s+/ : separator)
    const segment = args.segment ?? 'all'
    if (segment === 'all') return parts
    if (segment === 'first') return parts[0]
    if (segment === 'last') return parts.at(-1)
    const index = integer(args, 'segment')
    if (index < 0 || index >= parts.length) throw new StepError('validation', `Segment ${index} does not exist (${parts.length} segments)`)
    return parts[index]
  },
  'text.extract_email': args => extract(args, EMAIL, 'email address', match => match.toLowerCase()),
  'text.extract_url': args => extract(args, URL_PATTERN, 'URL'),
  'text.extract_phone': args => extract(args, PHONE, 'phone number', match => e164(match, typeof args.region === 'string' ? args.region : 'US')),
  'text.extract_number': args => extract(args, NUMBER, 'number', match => { const parsed = parseDecimal(match); return parsed ? toJson(parsed) : null }),
  'text.extract_pattern': args => {
    let pattern: RegExp
    try { pattern = new RegExp(text(args, 'pattern'), 'g' + (typeof args.flags === 'string' ? args.flags.replace(/[^imsu]/g, '') : '')) } catch { throw new StepError('validation', 'Invalid pattern') }
    const matches = [...text(args).matchAll(pattern)].map(match => ({ match: match[0], groups: match.slice(1), named: match.groups ?? {} }))
    if (args.all === true) return matches
    if (!matches.length) { if (args.if_none === 'null') return null; throw new StepError('validation', 'The pattern matched nothing') }
    return matches[0]
  },
  'text.replace': args => {
    const value = text(args), replacement = text(args, 'replace')
    if (args.pattern === true) {
      try { return value.replace(new RegExp(text(args, 'find'), 'g' + (typeof args.flags === 'string' ? args.flags.replace(/[^imsu]/g, '') : '')), replacement) } catch { throw new StepError('validation', 'Invalid pattern') }
    }
    return value.split(text(args, 'find')).join(replacement)
  },
  'text.case': args => {
    const value = text(args), to = choice(args, 'to', ['upper', 'lower', 'title', 'sentence'] as const)
    return to === 'upper' ? value.toUpperCase() : to === 'lower' ? value.toLowerCase() : to === 'title' ? titleCase(value) : sentenceCase(value)
  },
  'text.trim': args => { const value = text(args).trim(); return args.collapse === false ? value : value.replace(/\s+/g, ' ') },
  'text.truncate': args => {
    const value = text(args), length = integer(args, 'length')
    if (length < 1) throw new StepError('validation', 'length must be at least 1')
    const chars = [...value]
    if (chars.length <= length) return value
    return args.ellipsis === true ? chars.slice(0, Math.max(0, length - 1)).join('') + '…' : chars.slice(0, length).join('')
  },
  'text.strip_html': args => stripHtml(text(args)),
  'text.markdown_to_html': args => marked.parse(text(args), { async: false }) as string,
  'text.html_to_markdown': args => htmlToMarkdown(text(args)),
  'text.default': args => { const value = args.value; return value === undefined || value === null || (typeof value === 'string' && value.trim() === '') ? args.default : value },
  'text.url_encode': args => encodeURIComponent(text(args)),
  'text.url_decode': args => { try { return decodeURIComponent(text(args).replace(/\+/g, ' ')) } catch { throw new StepError('validation', 'The text is not valid URL encoding') } },
  'text.length': args => [...text(args)].length,
  'text.word_count': args => text(args).trim().split(/\s+/).filter(Boolean).length,
}
