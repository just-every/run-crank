// A step's last result in one or two lines, read from the response shapes the apps document:
// a QuickBooks Online invoice, a Google Sheets append, a Slack message, a filter, a path group and
// an approval. Any other response shows its first plain fields, with ISO dates in US form.
import { esc, personName } from '../document'
import { mappingRows, type Node } from './model'

const usDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}
const usd = (value: unknown) => typeof value === 'number' ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value) : ''
const plain = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? usDate(value) : String(value)

export interface Summary { title: string; lines: string[] }

function invoice(body: any, reconciled: boolean): Summary | null {
  const found = body?.Invoice ?? body?.QueryResponse?.Invoice?.[0]
  if (!found || typeof found !== 'object' || found.DocNumber === undefined) return null
  const place = [found.CustomerRef?.name, found.BillAddr?.City, found.BillAddr?.CountrySubDivisionCode].filter(Boolean).join(', ')
  const due = [found.DueDate ? `Due ${usDate(found.DueDate)}` : '', usd(found.TotalAmt)].filter(Boolean).join(' · ')
  return { title: `Invoice #${found.DocNumber} ${reconciled ? 'found by read-back, not created twice' : 'created'}`, lines: [place, due].filter(Boolean) }
}

function sheetRow(body: any): Summary | null {
  const range = body?.updates?.updatedRange
  if (typeof range !== 'string') return null
  const match = /^'?(.*?)'?!([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/.exec(range)
  return match ? { title: `Row ${Number(match[3]).toLocaleString('en-US')} added to “${match[1]}”`, lines: body.updates.updatedCells ? [`${body.updates.updatedCells} cells written`] : [] } : null
}

/** The summary of a step's recorded output, or null when only the status says anything. */
export function summaryOfResult(node: Node, record: any, people: { id: string; name: string }[]): Summary | null {
  const step = node.step, output = record?.output
  if (!step || !output || typeof output !== 'object') return null
  if (step.type === 'filter') return output.passed ? { title: 'Passed: the run went on', lines: [] } : { title: 'Stopped: the run ended here', lines: ['This event did not meet the conditions'] }
  if (step.type === 'paths' && Array.isArray(output.matched)) {
    const names = output.matched.map((id: string) => node.branches?.find(b => b.id === id)?.name ?? id)
    return { title: `Took ${names.join(' and ')}`, lines: [] }
  }
  if (step.type === 'approval' && typeof output.approved === 'boolean') return { title: `${output.approved ? 'Approved' : 'Rejected'} by ${personName(people, output.reviewer)}`, lines: output.reason ? [output.reason] : [] }
  if (step.type.startsWith('slack.') && output.ok) return { title: `Posted${typeof (record.input as any)?.channel === 'string' ? ` in ${(record.input as any).channel}` : ''}`, lines: typeof output.text === 'string' ? [output.text] : [] }
  if (output.status === undefined) return null
  const known = invoice(output.body, output.reconciled === true) ?? sheetRow(output.body)
  if (known) return known
  const leaves = output.body && typeof output.body === 'object' ? mappingRows(output.body).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, 4) : []
  return { title: `HTTP ${output.status}${output.reconciled ? ' · read back, not repeated' : ''}`, lines: leaves.map(([k, v]) => `${k} ${plain(v)}`) }
}

export const summaryHtml = (summary: Summary) => `<strong>${esc(summary.title)}</strong>${summary.lines.map(line => `<span>${esc(line)}</span>`).join('')}`
