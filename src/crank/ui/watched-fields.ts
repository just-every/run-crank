import { esc, hidden } from './document'

/** Existing trigger settings, with names loaded only after the builder asks. */
export function watchedFieldsPanel(workflowId: string, trigger: any, result?: any, error?: string) {
  const path = '/app/workflows/' + encodeURIComponent(workflowId)
  const body = result ? `<form method="post" action="/app/action">${hidden('path', `/api/crank/workflows/${workflowId}/trigger/fields`)}${hidden('return_to', path + '?step=trigger')}${hidden('draft_digest', result.draft_digest)}${hidden('schema_digest', result.schema_digest)}${hidden('watch_selection', 'true')}
    <label>Update choice<select name="watch_mode"><option value="selected"${trigger.any_field ? '' : ' selected'}>Selected fields</option><option value="any"${trigger.any_field ? ' selected' : ''}>Any field</option></select></label>
    <p>Any field can start a run on every edit.</p>
    <fieldset><legend>Watched fields</legend>${result.fields.map((field: any, i: number) => `<label><input type="checkbox" name="watch_${i}" value="${esc(field.name)}"${trigger.watched_fields?.includes(field.name) ? ' checked' : ''}> ${esc(field.label)}${field.label === field.name ? '' : ` (${esc(field.name)})`}</label>`).join('')}</fieldset>
    <button class="btn btn-secondary">Save watched fields</button></form>` : `<a class="btn btn-secondary" href="${path}?step=trigger&amp;watch_fields=1">Load field names</a>`
  return `<section class="panel"><details${result || error ? ' open' : ''}><summary>Watched field settings</summary>${trigger.any_field ? '<p class="notice" role="alert">Any field is selected: every edit can start a run.</p>' : ''}${error ? `<p class="notice" role="alert">${esc(error)}</p>` : ''}${body}</details></section>`
}
