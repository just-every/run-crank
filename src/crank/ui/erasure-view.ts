import { action, esc, hidden } from './document'

/** DATA-002 on the Data screen: erase everything carrying one identifier, or a former team member. */
export function erasurePanels(people:any[]) {
  const former = people.filter(p => p.role !== 'owner' && p.status === 'inactive' && !String(p.email).endsWith('@removed.invalid'))
  return `<section class="panel"><h2>Erase a person or key</h2><p class="muted">Enter one exact identifier, such as an email address or business key. The preview lists every run that carries it; nothing is erased until you confirm.</p><form method="post" action="/app/data/subject"><label>Identifier<input name="subject" required minlength="3" maxlength="500" autocomplete="off"></label><button class="btn btn-secondary">Preview erasure</button></form></section>
  <section class="panel"><h2>Erase a former team member</h2><p class="muted">Deactivate the person first. Their sign-in email and name are removed and their id becomes one anonymous label; what they did stays in the history under that label.</p>${former.length ? `<ul class="list">${former.map(p => `<li class="settings-row"><span class="row-main"><strong>${esc(p.displayName ?? p.display_name)}</strong><span class="muted">${esc(p.email)} · ${esc(p.role)}</span></span>${action('/api/crank/data/erase', 'Erase this person', { operator_id: p.id, confirm: 'ERASE' }, 'secondary')}</li>`).join('')}</ul>` : '<p class="muted">No deactivated team members.</p>'}</section>`
}

export function subjectPreview(subject:string, preview:any) {
  const rows = [...preview.workflow_runs.map((r:any) => ({ ...r, kind: 'Workflow run' })), ...preview.flow_runs.map((r:any) => ({ ...r, kind: 'Flow run' }))]
  return `<section class="panel"><h2>Erasure preview</h2><p>${rows.length} run${rows.length === 1 ? '' : 's'} carry this identifier.</p><ul class="list">${rows.map(r => `<li class="settings-row"><span class="row-main"><strong>${esc(r.kind)} ${esc(r.id.slice(0, 8))}</strong><span class="muted">${esc(r.status)}</span>${r.blocked ? `<span class="notice">${esc(r.blocked)}</span>` : ''}</span></li>`).join('')}</ul>
  ${preview.blocked ? '<p class="notice">Finish or cancel these runs and pause their workflows or flows, then preview again.</p>' : rows.length ? `<form method="post" action="/app/action">${hidden('path', '/api/crank/data/erase')}${hidden('subject', subject)}${hidden('digest', preview.digest)}<label>Type ERASE to confirm<input name="confirm" required pattern="ERASE"></label><button class="btn btn-danger">Erase these runs</button></form>` : ''}<a href="/app/data">Back to Data</a></section>`
}
