import { CrankError } from '../model'
import { esc, hidden, stateWords } from './document'

/** Native humans edit only the fields named by this run's immutable approval step. */
export function decisionFields(wait: any): string {
  const fields: string[] = Array.isArray(wait.editable) ? wait.editable : []
  return fields.map(field => {
    const value = wait.proposal?.[field], key = encodeURIComponent(field)
    const kind = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : value === null || typeof value === 'object' ? 'json' : 'string'
    const control = kind === 'boolean'
      ? `<select name="decision_edit_${esc(key)}"><option value="true"${value === true ? ' selected' : ''}>Yes</option><option value="false"${value === false ? ' selected' : ''}>No</option></select>`
      : kind === 'json' ? `<textarea name="decision_edit_${esc(key)}" rows="4">${esc(JSON.stringify(value))}</textarea>`
      : `<input name="decision_edit_${esc(key)}"${kind === 'number' ? ' type="number" step="any"' : ''} value="${esc(value ?? '')}">`
    return `${hidden('decision_kind_' + key, kind)}<label>${esc(stateWords(field))}${kind === 'json' ? ' (JSON)' : ''}${control}</label>`
  }).join('')
}
export function decisionEdits(form: Record<string,string>): Record<string,unknown> | undefined {
  const entries = Object.entries(form).filter(([key]) => key.startsWith('decision_edit_'))
  if (!entries.length) return
  try {
    return Object.fromEntries(entries.map(([key,value]) => {
      const encoded = key.slice('decision_edit_'.length), kind = form['decision_kind_' + encoded]
      let result: unknown = value
      if (kind === 'json') result = JSON.parse(value)
      if (kind === 'number') { if (value.trim() === '' || !Number.isFinite(Number(value))) throw new Error(); result = Number(value) }
      if (kind === 'boolean') { if (!['true','false'].includes(value)) throw new Error(); result = value === 'true' }
      return [decodeURIComponent(encoded),result]
    }))
  } catch { throw new CrankError(400,'A decision field has an invalid value. Review it before approving.') }
}
