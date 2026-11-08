import { chip, esc, hidden, stateWords } from './document'

interface TeamPolicy { grants?: {role:string;workflow_ids:string[];connection_ids:string[]}[]; operator_id: string; role: string; workflow_ids: string[]; connection_ids: string[] }
interface Person { id: string; displayName?: string; name?: string; email?: string; role: string; status: string }
interface Workflow { id: string; name: string; owner_id?: string }
interface Connection { id: string; label: string; app?: string; account_name?: string | null; status?: string }

const ROLES = [
  ['admin', 'Admin — manage selected workflows'],
  ['builder', 'Builder — prepare and publish selected workflows'],
  ['operator', 'Operator — start selected workflows'],
  ['approver', 'Approver — review selected workflow runs'],
  ['viewer', 'Viewer — read selected workflows'],
  ['auditor', 'Auditor — read value-free audit history'],
  ['billing', 'Billing admin — read aggregate usage'],
  ['none', 'No product access'],
] as const
const nameOf = (person: Person) => person.displayName ?? person.name ?? person.email ?? 'Unnamed person'
const formStart = (path: string) => `<form method="post" action="/app/action">${hidden('path', path)}${hidden('return_to', '/app/access')}`

function scopeChoices(kind: 'workflow' | 'connection', choices: { id: string; label: string }[], selected: string[]) {
  return `<section role="group" aria-label="${kind === 'workflow' ? 'Workflows' : 'Connections'}"><h4>${kind === 'workflow' ? 'Workflows' : 'Connections'}</h4>${choices.length
    ? `<div class="grid">${choices.map(choice => `<label><span><input type="checkbox" name="${esc(kind + '_' + choice.id)}" value="true"${selected.includes(choice.id) ? ' checked' : ''}> ${esc(choice.label)}</span></label>`).join('')}</div>`
    : `<p class="muted">No ${kind === 'workflow' ? 'workflows' : 'connections'} available.</p>`}</section>`
}

function personPolicy(person: Person, policy: TeamPolicy | undefined, workflows: Workflow[], connections: Connection[]) {
  const role = policy?.role ?? 'none'
  const summary = policy ? stateWords(role) : 'No product access'
  const workflowChoices = [{id:'workspace:production',label:'Create production workflows'},...workflows.map(workflow => ({ id: workflow.id, label: workflow.name }))]
  const connectionChoices = connections.map(connection => ({ id: connection.id,
    label: [connection.label, connection.account_name, connection.app, connection.status && connection.status !== 'active' ? stateWords(connection.status) : ''].filter(Boolean).join(' · ') }))
  return `<li class="history-item"><h3>${esc(nameOf(person))} ${chip(person.status)}</h3>
    <p>${esc(person.email ?? '')}${person.email ? ' · ' : ''}Base role: ${esc(stateWords(person.role))} · Product policy: ${esc(summary)}</p>
    ${person.role === 'owner' ? '<p class="muted">The workspace owner retains owner access and manages product policies.</p>' : person.status !== 'active' ? `<p class="muted">Inactive members cannot sign in. Reactivate their membership in People before changing product access.</p><p>Workflows: ${esc(workflowChoices.filter(choice => policy?.workflow_ids.includes(choice.id)).map(choice => choice.label).join(', ') || 'None')}<br>Connections: ${esc(connectionChoices.filter(choice => policy?.connection_ids.includes(choice.id)).map(choice => choice.label).join(', ') || 'None')}</p>` : `<details class="inline-disclosure"><summary>Manage access for ${esc(nameOf(person))}</summary>
    ${formStart('/api/crank/team/' + encodeURIComponent(person.id))}${hidden('team_scope_form', 'true')}
    ${policy?.grants?.length ? `<ul>${policy.grants.map(g=>`<li>${esc(stateWords(g.role))} · ${g.workflow_ids.length} workflows · ${g.connection_ids.length} connections</li>`).join('')}</ul>`:''}
    <label>Save mode<select name="grant_mode"><option value="replace">Replace existing grants</option><option value="add">Add another grant</option></select></label>
    <label>Product role<select name="role">${ROLES.map(([value, label]) => `<option value="${value}"${role === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    <p class="form-help">Select every workflow and connection this person may use. An empty selection grants no access in that group. Selecting “No product access” clears all product scopes.</p>
    ${scopeChoices('workflow', workflowChoices, policy?.workflow_ids ?? [])}${scopeChoices('connection', connectionChoices, policy?.connection_ids ?? [])}
    <button class="btn btn-secondary" aria-label="Save access for ${esc(nameOf(person))}">Save access</button></form></details>`}</li>`
}

function transferForm(workflows: Workflow[], people: Person[]) {
  const active = people.filter(person => person.status === 'active')
  return `<section class="panel"><h2>Transfer workflow ownership</h2>
    <p class="muted">Before a person leaves, assign their workflows to an active workspace member. Deactivate their membership in People when their handover is complete.</p>
    ${formStart('/api/crank/team/transfer')}<div class="grid">
    <label>Workflow<select name="workflow_id" required><option value="">Choose workflow</option>${workflows.map(workflow => {
      const owner = people.find(person => person.id === workflow.owner_id)
      return `<option value="${esc(workflow.id)}">${esc(workflow.name)}${workflow.owner_id ? ' · owned by ' + esc(owner ? nameOf(owner) : 'a former member') : ''}</option>`
    }).join('')}</select></label>
    <label>New owner<select name="new_owner_id" required><option value="">Choose active person</option>${active.map(person => `<option value="${esc(person.id)}">${esc(nameOf(person))}${person.email ? ' · ' + esc(person.email) : ''}</option>`).join('')}</select></label></div>
    <button class="btn btn-secondary"${workflows.length && active.length ? '' : ' disabled'}>Transfer ownership</button>
    ${workflows.length ? '' : '<p class="form-help">Create a workflow before transferring ownership.</p>'}
    ${active.length ? '' : '<p class="form-help">An active workspace member is required to receive ownership.</p>'}</form></section>`
}

/** Owner-only product policies supplement native workspace membership. */
export function teamPanel(team: TeamPolicy[], people: Person[], workflows: Workflow[], connections: Connection[]): string {
  const policies = new Map(team.map(policy => [policy.operator_id, policy]))
  return `<section class="panel"><h2>Team workflow access</h2>
    <p class="muted">Assign explicit grants with a product role and named workflow and connection scopes to workspace members. Each action and all its accounts must fit one grant. Admins can delegate within their own grant. Owner settings, data management, standing grants and credentials remain owner decisions. Connection secrets are never readable.</p>
    <p class="form-help">Role, scope and ownership changes are audited and apply from the next request. Approvers cannot approve their own runs.</p>
    ${people.length ? `<ul class="list">${people.map(person => personPolicy(person, policies.get(person.id), workflows, connections)).join('')}</ul>` : '<p class="muted">Invite a person in People before assigning workflow access.</p>'}
    </section>${transferForm(workflows, people)}`
}
