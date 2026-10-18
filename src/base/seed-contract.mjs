// A seed's CONTRACT.md as data: the product target, the clauses it defines,
// and its Status table. `rer check` validates it and the run site's /contract
// page is built from it, so both read the contract through this one parser.
// The shape it accepts is documented in SEED-COMMAND-CONTRACT.md ("Contract
// status"). It throws a ContractError listing every problem, each with the
// CONTRACT.md line it is on; it never guesses a missing value.
// Plain JavaScript (types in seed-contract.d.mts) so the rer CLI runs it under
// Node and the seed's Vite site build imports it from src/base.

export const kinds = Object.freeze(['published', 'target', 'push-further'])
export const statuses = Object.freeze(['done', 'partial', 'missing'])
export const statusHeader = Object.freeze(['Clause', 'Title', 'Kind', 'Status', 'Evidence', 'Gap'])
const summaryHeader = ['Clauses', 'Done', 'Partial', 'Missing', 'Total']

// The one clause-ID rule, shared with the release catalogue: uppercase words
// and a two- or three-digit number joined by hyphens (HOME-001, PAN-01), or the
// legacy hyphenless form of up to four capitals and a number (E1, A7).
export const clauseIdSource = '(?:[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-[0-9]{2,3}|[A-Z]{1,4}[0-9]{1,3})'
const id = clauseIdSource
const clauseId = new RegExp(`^${id}$`)
const dash = '\\s+[—–-]\\s+'
// The three ways a contract defines a clause: a bold bullet, a bold paragraph
// or a heading, each "ID — Title." at the start of its line.
const definitions = [
  new RegExp(`^-\\s+\\*\\*(${id})${dash}(.+?)\\*\\*`),
  new RegExp(`^\\*\\*(${id})${dash}(.+?)\\*\\*`),
  new RegExp(`^#{2,6}\\s+(${id})${dash}(.+?)\\s*#*\\s*$`),
]
const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const judged = /^Judged from the code and tests at commit `([0-9a-f]{7,40})` \(([^)]+)\)[.;:]/
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export class ContractError extends Error {
  constructor(file, problems) {
    super(problems.map(problem => `${file}:${problem.line}: ${problem.message}`).join('\n'))
    this.name = 'ContractError'
    this.file = file
    this.problems = problems
  }
}

/** Markdown inline text as plain text: links keep their label; emphasis and code marks go. */
export function plainText(value) {
  return value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2').trim()
}

const cleanTitle = value => plainText(value).replace(/[.:]$/, '').trim()

function cells(line) {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return body.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}
const isTableLine = line => line.trimStart().startsWith('|')
const isDivider = line => /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{0,}:?\s*$/.test(line.trim())

function isoDate(text) {
  let year, month, day
  const written = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(text), iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (written && months.includes(written[2])) [day, month, year] = [Number(written[1]), months.indexOf(written[2]) + 1, Number(written[3])]
  else if (iso) [year, month, day] = iso.slice(1).map(Number)
  else return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined
  return date.toISOString().slice(0, 10)
}

// Every heading outside fenced code, with the 1-based line it is on.
function outline(lines) {
  const headings = []
  let fence
  lines.forEach((line, index) => {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1]
    if (marker) { fence = fence === marker ? undefined : fence ?? marker; return }
    if (fence) return
    const match = heading.exec(line)
    if (match) headings.push({ level: match[1].length, text: plainText(match[2]), line: index + 1 })
  })
  return headings
}

// The section a heading opens: its line through the line before the next
// heading at its level or above.
function sectionEnd(headings, start, lineCount) {
  const next = headings.find(other => other.line > start.line && other.level <= start.level)
  return next ? next.line - 1 : lineCount
}

function readTarget(lines, headings, problems) {
  const section = headings.find(entry => entry.level === 2 && /^Product target\b/i.test(entry.text))
  if (!section) { problems.push({ line: 1, message: 'CONTRACT.md has no "## Product target" section with its Category, Incumbents and First buyer table.' }); return undefined }
  const end = sectionEnd(headings, section, lines.length), found = {}
  for (let line = section.line + 1; line <= end; line++) {
    const text = lines[line - 1]
    if (!isTableLine(text) || isDivider(text)) continue
    const [label = '', value = ''] = cells(text), name = plainText(label).toLowerCase()
    const key = name === 'category' ? 'category' : name.startsWith('incumbents') ? 'incumbents' : name === 'first buyer' ? 'firstBuyer' : /\balso beat\b/.test(name) ? 'alsoBeats' : undefined
    if (key && !found[key]) found[key] = { value: plainText(value), line }
  }
  for (const [key, label] of [['category', 'Category'], ['incumbents', 'Incumbents a buyer switches from'], ['firstBuyer', 'First buyer']])
    if (!found[key]?.value) problems.push({ line: found[key]?.line ?? section.line, message: `The Product target table needs a non-empty "${label}" row.` })
  if (!found.category?.value || !found.incumbents?.value || !found.firstBuyer?.value) return undefined
  const incumbents = found.incumbents.value.split(/\s*,\s*|\s+(?:and|or)\s+/).map(name => name.trim()).filter(Boolean)
  return { category: found.category.value, incumbents, replaces: found.incumbents.value, alsoBeats: found.alsoBeats?.value || null, firstBuyer: found.firstBuyer.value }
}

/** An area's anchor: "Archive, trash and deletion" -> "archive-trash-and-deletion". */
export function areaSlug(name) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
// Target and push-further areas sit under (or are) a heading starting
// "Target clauses" or "Push further"; every other area is published.
const targetSection = /^(?:Target clauses|Push further)\b/i
function areaGroup(headings, area) {
  let level = area.level + 1
  for (const entry of headings.filter(other => other.line <= area.line).reverse()) {
    if (entry.level >= level) continue
    if (targetSection.test(entry.text)) return 'target'
    level = entry.level
  }
  return 'published'
}

// A clause's prose, on one line: what follows its definition on that line, then
// the lines below it up to the next heading or definition. A bullet's body also
// ends at the first unindented line; a bold paragraph's or heading's runs on.
function bodyText(lines, line, form, rest) {
  const body = [rest]
  for (let next = line; next < lines.length; next++) {
    const text = lines[next]
    if (heading.test(text) || definitions.some(pattern => pattern.test(text)) || (form === 0 && text.trim() && !/^[\t ]/.test(text))) break
    body.push(text)
  }
  return body.join(' ').replace(/\s+/gu, ' ').trim()
}

// Clause definitions everywhere except the Status section and retired-ID
// sections. The area is the nearest heading above that is not a clause.
// A clause's own "*Status:* partial." line, kept beside its text, is recorded
// so a row that disagrees with it is refused.
function readDefinitions(lines, headings, skipped, problems) {
  const defined = new Map(), areas = new Map(), slugs = new Map()
  let fence, current
  lines.forEach((text, index) => {
    const line = index + 1
    const marker = /^\s*(```|~~~)/.exec(text)?.[1]
    if (marker) { fence = fence === marker ? undefined : fence ?? marker; return }
    if (fence || skipped.some(([start, end]) => line >= start && line <= end)) { current = undefined; return }
    const form = definitions.findIndex(pattern => pattern.test(text)), match = form < 0 ? null : definitions[form].exec(text)
    if (!match) {
      if (heading.test(text)) current = undefined
      const stated = /^\*{1,2}Status:\*{1,2}\s*(done|partial|missing)\b/.exec(text)
      if (stated && current && !current.stated) current.stated = { status: stated[1], line }
      return
    }
    const area = headings.filter(entry => entry.line < line && !definitions[2].test(lines[entry.line - 1])).at(-1)
    const [, clause, title] = match
    if (defined.has(clause)) { problems.push({ line, message: `${clause} is defined twice (first at line ${defined.get(clause).line}).` }); return }
    if (!area) { problems.push({ line, message: `${clause} is defined above every section heading, so it has no area.` }); return }
    current = { id: clause, title: cleanTitle(title), area: area.text, line, text: bodyText(lines, line, form, text.slice(match[0].length)) }
    defined.set(clause, current)
    const group = areaGroup(headings, area), known = areas.get(area.text)
    if (known && known.group !== group) problems.push({ line: area.line, message: `Area "${area.text}" is a ${group} area here but a ${known.group} area at line ${known.line}; give one of them its own name.` })
    if (known) return
    const slug = areaSlug(area.text)
    if (!slug) problems.push({ line: area.line, message: `Area "${area.text}" has no letters or digits to make its #area- link from.` })
    else if (slugs.has(slug)) problems.push({ line: area.line, message: `Area "${area.text}" has the same link (#area-${slug}) as "${slugs.get(slug).text}" at line ${slugs.get(slug).line}; rename one.` })
    else slugs.set(slug, area)
    areas.set(area.text, { name: area.text, slug, group, line: area.line })
  })
  return { defined, areas }
}

function readSummary(lines, start, problems) {
  const rows = []
  for (let line = start + 2; line <= lines.length && isTableLine(lines[line - 1]); line++) {
    const [label, ...numbers] = cells(lines[line - 1])
    const values = numbers.map(value => /^\d+$/.test(value) ? Number(value) : NaN)
    if (values.length !== 4 || values.some(Number.isNaN)) { problems.push({ line, message: 'A summary row is a label and four whole numbers: Done, Partial, Missing, Total.' }); continue }
    rows.push({ line, label: plainText(label), done: values[0], partial: values[1], missing: values[2], total: values[3] })
  }
  return rows
}

// Which kinds a summary row counts: "All", or kinds joined by "and".
function summaryKinds(label) {
  const name = label.toLowerCase()
  if (name === 'all' || name === 'total') return kinds
  const parts = name.split(/\s*,\s*|\s+and\s+/).map(part => part === 'push further' ? 'push-further' : part)
  return parts.every(part => kinds.includes(part)) ? parts : undefined
}

function checkSummaries(summaries, sentences, clauses, problems) {
  const count = selected => {
    const rows = clauses.filter(clause => selected.includes(clause.kind))
    return { done: rows.filter(row => row.status === 'done').length, partial: rows.filter(row => row.status === 'partial').length, missing: rows.filter(row => row.status === 'missing').length, total: rows.length }
  }
  for (const row of summaries) {
    const selected = summaryKinds(row.label)
    if (!selected) { problems.push({ line: row.line, message: `Summary row "${row.label}" names no kind: use All, Published, Target, Push further, or kinds joined by "and".` }); continue }
    const actual = count(selected)
    const wrong = ['done', 'partial', 'missing', 'total'].filter(key => row[key] !== actual[key])
    if (wrong.length) problems.push({ line: row.line, message: `Summary row "${row.label}" says ${wrong.map(key => `${row[key]} ${key}`).join(', ')}; the Status table has ${wrong.map(key => `${actual[key]} ${key}`).join(', ')}.` })
  }
  const all = count(kinds)
  for (const sentence of sentences) {
    const wrong = ['total', 'done', 'partial', 'missing'].filter(key => sentence[key] !== undefined && sentence[key] !== all[key])
    if (wrong.length) problems.push({ line: sentence.line, message: `The summary says ${wrong.map(key => `${sentence[key]} ${key === 'total' ? 'clauses' : key}`).join(', ')}; the Status table has ${wrong.map(key => `${all[key]} ${key === 'total' ? 'clauses' : key}`).join(', ')}.` })
  }
}

/**
 * Parse CONTRACT.md text. `file` names it in error messages.
 * @returns {import('./seed-contract.d.mts').SeedContract}
 */
export function parseContract(text, { file = 'CONTRACT.md' } = {}) {
  if (typeof text !== 'string') throw new TypeError('parseContract takes the CONTRACT.md text.')
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), headings = outline(lines), problems = []
  const statusHeading = headings.filter(entry => entry.level === 2 && entry.text === 'Status')
  if (statusHeading.length !== 1) throw new ContractError(file, [statusHeading.length ? { line: statusHeading[1].line, message: 'CONTRACT.md has more than one "## Status" section.' } : { line: lines.length, message: 'CONTRACT.md has no "## Status" section.' }])
  const status = statusHeading[0], statusEnd = sectionEnd(headings, status, lines.length)
  const skipped = [[status.line, statusEnd], ...headings.filter(entry => /^Retired\b/i.test(entry.text)).map(entry => [entry.line, sectionEnd(headings, entry, lines.length)])]
  const target = readTarget(lines, headings, problems)
  const { defined, areas: areaHeadings } = readDefinitions(lines, headings, skipped, problems)

  // The judged-at line opens the section.
  let commit, date
  const first = lines.slice(status.line, statusEnd).findIndex(line => line.trim()) + status.line + 1
  const opening = first > status.line ? judged.exec(lines[first - 1].trim()) : null
  if (!opening) problems.push({ line: first > status.line ? first : status.line, message: 'The Status section opens with "Judged from the code and tests at commit `<sha>` (<date>)."' })
  else {
    commit = opening[1]
    date = isoDate(opening[2])
    if (!date) problems.push({ line: first, message: `"${opening[2]}" is not a date: write it as 16 October 2026 or 2026-10-16.` })
  }

  // The section's tables: optional summaries, then exactly one clause table.
  const summaries = [], sentences = [], clauses = [], rows = new Map()
  let tableLine, wrongHeader
  for (let line = status.line + 1; line <= statusEnd; line++) {
    const textLine = lines[line - 1]
    const sentence = /\b(\d+) clauses?:\s*(\d+) done,\s*(\d+) partial(?:,| and)\s*(\d+) missing\b/i.exec(textLine)
    if (sentence) sentences.push({ line, total: Number(sentence[1]), done: Number(sentence[2]), partial: Number(sentence[3]), missing: Number(sentence[4]) })
    if (!isTableLine(textLine)) continue
    const header = cells(textLine)
    let end = line
    while (end + 1 <= statusEnd && isTableLine(lines[end])) end++
    if (!isDivider(lines[line] ?? '')) problems.push({ line: line + 1, message: 'A table header is followed by its |---| divider line.' })
    if (header.join('|') === summaryHeader.join('|')) summaries.push(...readSummary(lines, line, problems))
    else if (tableLine) problems.push({ line, message: `The Status section has one clause table (at line ${tableLine}); this is a second table.` })
    else if (header.join('|') !== statusHeader.join('|')) { wrongHeader = true; problems.push({ line, message: `The Status table header is | ${statusHeader.join(' | ')} |, not | ${header.join(' | ')} |.` }) }
    else {
      tableLine = line
      if (end < line + 2) problems.push({ line, message: 'The Status table has no rows: it holds one row per clause the contract defines.' })
      for (let rowLine = line + 2; rowLine <= end; rowLine++) {
        const row = cells(lines[rowLine - 1])
        if (row.length !== statusHeader.length) { problems.push({ line: rowLine, message: `A Status row has ${statusHeader.length} cells (${statusHeader.join(', ')}); this one has ${row.length}.` }); continue }
        const [clauseCell, titleCell, kind, state, evidenceCell, gapCell] = row, clause = plainText(clauseCell), title = cleanTitle(titleCell)
        if (!clauseId.test(clause)) { problems.push({ line: rowLine, message: `"${clauseCell}" is not a clause ID such as HOME-001.` }); continue }
        if (rows.has(clause)) { problems.push({ line: rowLine, message: `${clause} has a second Status row (the first is at line ${rows.get(clause)}).` }); continue }
        rows.set(clause, rowLine)
        const definition = defined.get(clause)
        if (!definition) problems.push({ line: rowLine, message: `${clause} has a Status row but CONTRACT.md defines no such clause.` })
        else if (title && title !== definition.title) problems.push({ line: rowLine, message: `${clause} is titled "${title}" here but "${definition.title}" where it is defined (line ${definition.line}).` })
        if (definition?.stated && statuses.includes(state) && definition.stated.status !== state) problems.push({ line: rowLine, message: `${clause} is ${state} here but its own Status line says ${definition.stated.status} (line ${definition.stated.line}).` })
        if (!kinds.includes(kind)) problems.push({ line: rowLine, message: `${clause} kind "${kind}" is not one of ${kinds.join(', ')}.` })
        if (!statuses.includes(state)) problems.push({ line: rowLine, message: `${clause} status "${state}" is not one of ${statuses.join(', ')}.` })
        if (!title) problems.push({ line: rowLine, message: `${clause} has no title.` })
        const evidence = [...evidenceCell.matchAll(/`([^`]+)`/g)].map(match => match[1].trim()).filter(Boolean), gap = plainText(gapCell)
        if (state === 'done' && !evidence.length) problems.push({ line: rowLine, message: `${clause} is done, so its Evidence names the repository path that proves it, in backticks.` })
        if (state === 'partial' && !evidence.length) problems.push({ line: rowLine, message: `${clause} is partial, so its Evidence names the repository path that backs it, in backticks.` })
        if ((state === 'partial' || state === 'missing') && !gap) problems.push({ line: rowLine, message: `${clause} is ${state}, so its Gap says what is missing.` })
        if (definition && kinds.includes(kind) && statuses.includes(state)) clauses.push({ id: clause, title, kind, status: state, evidence, gap, area: definition.area, text: definition.text, line: definition.line, row: rowLine })
      }
    }
    line = end
  }
  if (!tableLine) { if (!wrongHeader) problems.push({ line: status.line, message: `The Status section has no | ${statusHeader.join(' | ')} | table.` }) }
  else for (const definition of defined.values()) if (!rows.has(definition.id)) problems.push({ line: definition.line, message: `${definition.id} is defined here but has no Status row.` })
  if (!problems.length) checkSummaries(summaries, sentences, clauses, problems)
  if (problems.length) throw new ContractError(file, problems.sort((a, b) => a.line - b.line))

  const tally = rows => {
    const counts = { done: 0, partial: 0, missing: 0, total: rows.length }
    for (const row of rows) counts[row.status]++
    return counts
  }
  const areas = [...areaHeadings.values()].map(({ name, slug, group }) => {
    const own = clauses.filter(clause => clause.area === name).sort((a, b) => a.line - b.line)
    return { name, slug, group, clauses: own.map(clause => clause.id), ...tally(own) }
  }).filter(area => area.total)
  const counts = tally(clauses)
  return { commit, date, target, areas, clauses, counts }
}
