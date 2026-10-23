// The run site's /contract page: the seed's CONTRACT.md as parseContract reads
// it, drawn as br's "headline" design (rer-consolidation evidence/br-contract
// SPEC.md): the done count set large beside one stacked bar, the kind split and
// product target, progress by area beside every clause, and how statuses are
// judged. Every number comes from the parsed contract; nothing is typed here.
// It works without scripts; contract-filter.ts adds the status chips and search.
// This file is copied unchanged to src/base by both maintained exporters.
import { checkIdentity, type EditionIdentity } from './identity'
import { checkRunData, document, escape, header, siteLinks, type RunData } from './run-site'
import { CONTRACT_STYLE } from './contract-style'
import { CONTRACT_FILTER } from './contract-filter'
import type { ClauseStatus, ContractClause, SeedContract } from './seed-contract.mjs'

type Counts = SeedContract['counts']
const order: ClauseStatus[] = ['done', 'partial', 'missing']
const word: Record<ClauseStatus, string> = { done: 'Done', partial: 'Partial', missing: 'Missing' }
// The judged date is a calendar day, independent of the build machine's zone.
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** Whole percentages of the total by largest remainder, so the three add to 100; a non-zero share under 1% reads "<1%". */
export function shares(counts: Counts): Record<ClauseStatus, string> {
  const exact = order.map(status => counts.total ? counts[status] * 100 / counts.total : 0), whole = exact.map(Math.floor)
  let left = counts.total ? 100 - whole.reduce((sum, value) => sum + value, 0) : 0
  for (const index of exact.map((_, index) => index).sort((a, b) => (exact[b] - whole[b]) - (exact[a] - whole[a]))) if (left > 0) { whole[index]++; left-- }
  return Object.fromEntries(order.map((status, index) => [status, counts[status] && !whole[index] ? '<1%' : `${whole[index]}%`])) as Record<ClauseStatus, string>
}

const tally = (clauses: ContractClause[]): Counts => {
  const counts = { done: 0, partial: 0, missing: 0, total: clauses.length }
  for (const clause of clauses) counts[clause.status]++
  return counts
}
const glyph = (status: ClauseStatus, size: number) => `<svg class="glyph" width="${size}" height="${size}" aria-hidden="true" focusable="false"><use href="#g-${status}"/></svg>`
const SYMBOLS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">'
  + '<symbol id="g-done" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" style="fill:var(--rer-done)"/><path d="M7 12.4l3.3 3.3L17.2 8.8" style="fill:none;stroke:#fff;stroke-width:3;stroke-linecap:round;stroke-linejoin:round"/></symbol>'
  + '<symbol id="g-partial" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.4" style="fill:var(--rer-surface,#fff)"/><path d="M12 1.6a10.4 10.4 0 0 0 0 20.8z" style="fill:var(--rer-partial)"/><circle cx="12" cy="12" r="10.4" style="fill:none;stroke:var(--rer-partial-ink);stroke-width:2.2"/></symbol>'
  + '<symbol id="g-missing" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" style="fill:none;stroke:var(--rer-missing-ink);stroke-width:3;stroke-dasharray:4.5 4.5"/></symbol></svg>'

/** One stacked bar: a segment per non-zero status, sized by its share of the total. */
function stacked(counts: Counts, labelled: boolean): string {
  const share = shares(counts)
  return order.filter(status => counts[status]).map(status => `<span class="seg ${status}" style="flex-grow:${counts[status]}">`
    + (labelled ? `<span class="pct">${share[status]}<span class="cnt"> (${counts[status]})</span></span>` : '') + '</span>').join('')
}
const split = (counts: Counts) => order.map(status => `<span class="ink-${status}">${counts[status]} ${status}</span>`).join('<span class="sep"> · </span>')
const plainCounts = (counts: Counts) => order.map(status => `${counts[status]} ${status}`).join(' · ')
const areaCount = (n: number) => `${n} ${n === 1 ? 'area' : 'areas'}`
const pathHtml = (path: string) => escape(path).replaceAll('/', '/<wbr>')
const kindWord = (clause: ContractClause) => clause.kind === 'push-further' ? 'push further' : clause.kind

function clauseRow(clause: ContractClause, contractUrl: string): string {
  const line = `${contractUrl}?plain=1#L${clause.line}`
  const find = [clause.id, clause.title, clause.area, ...clause.evidence, clause.gap].join(' ').toLowerCase()
  const evidence = clause.status === 'missing' ? '' : clause.evidence.map(path => `<code class="path">${pathHtml(path)}</code>`).join('')
  const gap = clause.status === 'done' || !clause.gap ? '' : `<span class="gap">Gap: ${clause.gap === 'see the clause' ? `<a href="${escape(line)}">see the clause</a>` : escape(clause.gap)}</span>`
  return `<tr class="clause" data-id="${escape(clause.id)}" data-status="${clause.status}" data-kind="${clause.kind}" data-area="${escape(clause.area)}" data-find="${escape(find)}">`
    + `<td class="id"><a href="${escape(line)}">${escape(clause.id)}</a><span class="kind">${kindWord(clause)}</span></td><td class="title">${escape(clause.title)}</td>`
    + `<td class="status"><span class="st ink-${clause.status}">${glyph(clause.status, 16)}${word[clause.status]}</span></td><td class="ev">${evidence}${gap}</td></tr>`
}

/** /contract: what the seed is being built to do, and how much of it the code does today. */
export function contractPageHtml(identity: EditionIdentity, run: RunData, contract: SeedContract): string {
  checkIdentity(identity); checkRunData(run)
  const product = escape(identity.product), { counts, target } = contract
  const repository = run.repository.replace(/\/+$/, ''), contractUrl = `${repository}/blob/main/CONTRACT.md`
  const short = contract.commit.slice(0, 7), date = dateFormat.format(new Date(`${contract.date}T00:00:00Z`))
  const areaOrder = new Map(contract.areas.map((area, index) => [area.name, index]))
  const clauses = [...contract.clauses].sort((a, b) => areaOrder.get(a.area)! - areaOrder.get(b.area)! || a.line - b.line)
  const published = tally(clauses.filter(clause => clause.kind === 'published')), targeted = tally(clauses.filter(clause => clause.kind !== 'published'))

  const progress = `<section id="progress" class="hero" aria-label="Progress" data-done="${counts.done}" data-partial="${counts.partial}" data-missing="${counts.missing}" data-total="${counts.total}" data-commit="${escape(short)}" data-date="${contract.date}">`
    + `<p class="figure"><span class="big">${counts.done}</span> <span class="of"><span>of ${counts.total}</span> <span>clauses done</span></span></p>`
    + `<div class="hero-side"><div class="meter" role="img" aria-label="${counts.done} done, ${counts.partial} partial, ${counts.missing} missing, of ${counts.total} clauses">${stacked(counts, true)}</div>`
    + `<div class="hero-foot"><ul class="legend">${order.map(status => `<li>${glyph(status, 24)}<span>${counts[status]} ${status}</span></li>`).join('')}</ul>`
    + `<div class="judged"><p>Judged at commit <a class="sha" href="${escape(`${repository}/commit/${contract.commit}`)}">${escape(short)}</a> · <time datetime="${contract.date}">${date}</time></p><p><a href="#how-judged">How statuses are judged</a></p></div></div></div></section>`

  const kinds = `<section class="card split" aria-label="Clauses by kind"><div><h2>Published clauses</h2><p class="line">${split(published)}</p><p class="of-n">of ${published.total}</p></div>`
    + `<div><h2>Target and push further</h2>${targeted.total ? `<p class="line">${split(targeted)}</p><p class="of-n">of ${targeted.total}</p>` : '<p class="line none">No target clauses</p>'}</div></section>`
  const facts: [string, string][] = [['Category', target.category], ['Replaces', target.replaces], ...(target.alsoBeats ? [['Must also beat', target.alsoBeats] as [string, string]] : []), ['First buyer', target.firstBuyer]]
  // Each column's width follows its text, so a long incumbents list or first buyer gets the room.
  const columns = facts.map(([, value]) => `minmax(0,${Math.min(2.4, Math.max(1, value.length / 45)).toFixed(2)}fr)`).join(' ')
  const productTarget = `<section class="card target" aria-labelledby="target-title"><h2 id="target-title">Product target</h2><dl style="grid-template-columns:${columns}">${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl></section>`

  const groups = (['published', 'target'] as const).map(group => [group, contract.areas.filter(area => area.group === group)] as const).filter(([, areas]) => areas.length)
  const areaCard = `<section class="card areas" aria-labelledby="areas-title"><div class="card-head"><h2 id="areas-title">Progress by area</h2><span class="count">${areaCount(contract.areas.length)}</span></div>`
    + `<div class="area-row area-cols" aria-hidden="true"><span></span>${order.map(status => `<span class="n">${glyph(status, 16)}</span>`).join('')}<span></span></div>`
    + groups.map(([group, areas]) => `<h3 class="sub">${group === 'published' ? 'Published' : 'Target and push further'} · ${areaCount(areas.length)}</h3><ul class="area-list">`
      + areas.map(area => `<li><a class="area-row" href="#area-${area.slug}" data-area="${escape(area.name)}" data-done="${area.done}" data-partial="${area.partial}" data-missing="${area.missing}">`
        + `<span class="name">${escape(area.name)}</span>${order.map(status => `<span class="n${area[status] ? ` ink-${status}` : ' zero'}">${area[status]}<span class="vh"> ${status}</span></span>`).join('')}`
        + `<span class="mini" aria-hidden="true">${stacked(area, false)}</span></a></li>`).join('') + '</ul>').join('')
    + '</section>'

  // The clause column holds the longest ID (or kind word) whole, in the mono face's ch.
  const idWidth = Math.max(...clauses.map(clause => Math.max(clause.id.length, kindWord(clause).length)))
  const bodies = contract.areas.map(area => `<tbody class="area" data-area="${escape(area.name)}"><tr class="group" id="area-${area.slug}"><th colspan="4" scope="colgroup"><span class="group-name">${escape(area.name)}</span> <span class="group-counts">${plainCounts(area)}</span></th></tr>`
    + clauses.filter(clause => clause.area === area.name).map(clause => clauseRow(clause, contractUrl)).join('') + '</tbody>').join('')
  const chips = [['all', 'All', ''], ...order.map(status => [status, word[status], glyph(status, 14)])].map(([status, label, icon]) => `<button type="button" data-status="${status}" aria-pressed="${status === 'all'}">${icon}${label} <b>${status === 'all' ? counts.total : counts[status as ClauseStatus]}</b></button>`).join('')
  const clauseCard = `<section class="card clauses" id="clauses" aria-labelledby="clauses-title"><div class="card-head"><h2 id="clauses-title">All clauses</h2>`
    + `<label class="search" hidden data-enhance><span class="vh">Find a clause</span><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4 4"/></svg><input type="search" placeholder="Find a clause" autocomplete="off"></label></div>`
    + `<div class="chips" role="group" aria-label="Filter by status" hidden data-enhance>${chips}</div>`
    + `<p class="live" aria-live="polite" hidden data-enhance>Showing ${counts.total} of ${counts.total} clauses</p>`
    + `<table><colgroup><col class="c-id" style="width:calc(${idWidth}ch + 18px)"><col><col class="c-status"><col class="c-ev"></colgroup><thead><tr><th scope="col">Clause</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Evidence or gap</th></tr></thead>`
    + `${bodies}<tbody class="empty" hidden><tr><td colspan="4"><span class="empty-text"></span> <button type="button" class="clear">Clear filters</button></td></tr></tbody></table></section>`

  const judging = `<section class="card judging" id="how-judged" aria-labelledby="judged-title"><h2 id="judged-title">How statuses are judged</h2><dl>`
    + `<div><dt class="ink-done">${glyph('done', 24)}Done</dt><dd>It ships in the default install, and a cited test or journey exercises it.</dd></div>`
    + `<div><dt class="ink-partial">${glyph('partial', 24)}Partial</dt><dd>Some of it ships, it ships only behind an opt-in, or there is code with no requirement-level test.</dd></div>`
    + `<div><dt class="ink-missing">${glyph('missing', 24)}Missing</dt><dd>There is no implementation.</dd></div></dl>`
    + `<p class="read"><a href="${escape(contractUrl)}">Read CONTRACT.md on GitHub</a></p></section>`

  const footer = `<footer class="foot"><div class="foot-brand"><a class="brand" href="/"><img src="${escape(identity.mark)}" alt="" width="28" height="28"><span>${product}</span></a><p>${escape(identity.tagline)}</p></div>`
    + `<nav aria-label="Footer">${siteLinks(run, contract)}</nav><p class="licence">${escape(run.licence)} licensed</p></footer>`

  const body = `${SYMBOLS}${header(identity, run, contract, 'contract')}<main><p class="eyebrow">Contract</p><h1>What ${product} is being built to do</h1>`
    + `<p class="lead">Every clause of the product ${product} is building toward, and how much of it the code does today. Judged from the code and tests, not from plans.</p>`
    + `${progress}<div class="layout">${kinds}${productTarget}${areaCard}${clauseCard}</div>${judging}${footer}</main>`
  const description = `What ${identity.product} is being built to do, and how much of it the code does today: ${counts.done} of ${counts.total} clauses done, judged at ${short} on ${date}.`
  return document({ ...identity, band: undefined }, `Contract · ${identity.product}`, description, CONTRACT_STYLE, body, CONTRACT_FILTER)
}
