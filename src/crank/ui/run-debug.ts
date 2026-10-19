import { esc, json, timestamp } from './document'
import type { RunDetail } from './editor/model'
import { RUN_STATE } from './editor/runs'

/** Only provider-returned web links are navigable; data is always rendered literally. */
function remoteLinks(value: unknown): string {
  const links = new Set<string>()
  const walk = (item: unknown, depth: number) => {
    if (depth > 8 || !item || typeof item !== 'object') return
    for (const [key, v] of Object.entries(item)) {
      if (typeof v === 'string' && /^(url|web_url|webUrl|html_url|permalink)$/.test(key)) {
        try { const u = new URL(v); if (u.protocol === 'https:' && !u.username && !u.password && ![...u.searchParams.keys()].some(k => /token|secret|key|auth|signature/i.test(k))) links.add(u.href) } catch {}
      } else walk(v, depth + 1)
    }
  }
  walk(value, 0)
  return [...links].map(url => `<p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open remote record</a></p>`).join('')
}

export function stepDebug(record: any) {
  return `${record.trace !== undefined && record.trace !== null ? `<details class="inline-disclosure"><summary>Rule and path results</summary><pre>${json(record.trace)}</pre></details>` : ''}${record.operation_key ? `<p class="muted">Operation <code>${esc(record.operation_key)}</code>${record.output?.attempts ? ` · ${esc(record.output.attempts)} HTTP attempts` : ''}</p>` : ''}${remoteLinks(record.output)}`
}

export function runComparison(run: RunDetail, comparison: RunDetail | null, prior: any[]) {
  const choices = [...prior.filter(r => r.id !== run.id)]
  if (comparison && !choices.some(r => r.id === comparison.id)) choices.push(comparison)
  const form = `<form method="get" action="/app/workflow-runs/${esc(run.id)}"><label>Compare with another run<select name="compare"><option value="">Choose a run</option>${choices.map(r => `<option value="${esc(r.id)}"${comparison?.id === r.id ? ' selected' : ''}>${esc(r.business_key ?? r.id.slice(0, 8))} · ${esc(RUN_STATE[r.status] ?? r.status)} · ${esc(r.received_at)}</option>`).join('')}</select></label><label>Or enter an older run ID<input name="older" value="" placeholder="Run ID from history"></label><button class="btn btn-secondary">Compare runs</button></form>`
  if (!comparison) return `<section class="panel"><h2>Compare runs</h2>${form}</section>`
  const snapshot = (r: RunDetail) => `<p>Version ${esc(r.version?.number ?? '—')} · ${esc(RUN_STATE[r.status] ?? r.status)}</p><h4>Original input</h4><pre>${json(r.trigger ?? 'restricted')}</pre><h4>Steps and decisions</h4>${r.steps.map(step => `<article class="history-item"><strong>${esc(step.path)} · ${esc(step.status)}</strong><details class="inline-disclosure"><summary>Mapping, output and rule results</summary><pre>${json({ input: step.input ?? 'restricted', output: step.output ?? 'restricted', rules: step.trace ?? null, error: step.error })}</pre></details>${remoteLinks(step.output)}</article>`).join('')}${r.waits.length ? `<details class="inline-disclosure"><summary>Approval decisions (${r.waits.length})</summary><pre>${json(r.waits)}</pre></details>` : ''}${r.attempts?.length ? `<details class="inline-disclosure"><summary>HTTP attempts (${r.attempts.length})</summary><pre>${json(r.attempts)}</pre></details>` : ''}`
  return `<section class="panel"><h2>Compare runs</h2>${form}<div class="grid"><div><h3>This run · ${esc(run.id.slice(0, 8))}</h3><p>${timestamp(run.received_at)}</p>${snapshot(run)}</div><div><h3>Prior run · <a href="/app/workflow-runs/${esc(comparison.id)}">${esc(comparison.id.slice(0, 8))}</a></h3><p>${timestamp(comparison.received_at)}</p>${snapshot(comparison)}</div></div></section>`
}
