import { action, chip, esc, hidden, json, timestamp } from './document'

const toolsExample = [{name:'send_channel_message',description:'Send a message to the granted Slack channel',step_id:'message',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},fixed:{channel:'Choose an exact channel ID'}}]
const policyExample = {rules:[{step_id:'message',type:'slack.send_channel_message',connection_id:'Choose the managed connection ID',app:'slack',fields:['channel','text'],recipient_field:'channel',recipients:['Choose an exact channel ID'],max_per_minute:5}],approval:{timeout_seconds:86400,delegate_ids:[],escalate_to:[]}}

/** Configuration lives under Access; client secrets are displayed only at issuance. */
export function mcpClientsPanel(clients: any[], workflows: any[], calls: any[] = [], selected?: string) {
  const published = workflows.filter(w=>w.status==='published' && w.published_version_id)
  return `<section class="panel"><h2>AI client access</h2><p>Give each AI client its own tools, limits and revocable secret.</p>
    <form method="post" action="/app/action">${hidden('path','/api/crank/mcp-clients')}${hidden('return_to','/app/settings/mcp')}
    <div class="grid grid-3"><label>Client name<input name="label" required maxlength="200" placeholder="Harbor operations assistant"></label>
    <label>Published tool workflow<select name="workflow_id" required><option value="">Choose workflow</option>${published.map(w=>`<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></label>
    <label>Expires at (UTC)<input name="expires_at" required placeholder="YYYY-MM-DDTHH:mm:ssZ"></label></div>
    <details><summary>Tool and grant setup</summary><p>Choose native connector steps from the publication. Tool arguments use structural JSON types. Fixed parameters are hidden from the client; recipients, amounts and request rates remain hard limits. An optional approval_step_id names a stopping approval step whose grant allows its proposal field.</p>
    <label>Enabled tools (JSON)<textarea name="tools" required rows="10" spellcheck="false" placeholder="${esc(JSON.stringify(toolsExample,null,2))}"></textarea></label>
    <label>Standing grant (JSON)<textarea name="policy" required rows="10" spellcheck="false" placeholder="${esc(JSON.stringify(policyExample,null,2))}"></textarea></label>
    <p>The grant needs one rule per leaf step. New publication, expiry or revocation stops calls. Inspect outgoing data in <a href="/app/data">Data</a> before connecting a client.</p></details>
    <button class="btn btn-primary"${published.length?'':' disabled'}>Create client server</button>${published.length?'':'<p>Publish a workflow with connector tools first.</p>'}</form></section>
    <section class="panel"><h2>Client servers</h2>${clients.length?`<ul class="list">${clients.map(c=>`<li class="history-item"><div class="title-row"><h3>${esc(c.label)}</h3>${chip(c.revoked_at?'revoked':Date.parse(c.expires_at)<=Date.now()?'inactive':'active')}</div><p>Expires ${timestamp(c.expires_at)} · ${c.tools.length} enabled tools</p><label>Server URL<input readonly value="${esc(c.url)}" aria-label="Server URL"></label><details><summary>Enabled tools</summary><pre>${json(c.tools)}</pre></details><a href="/app/settings/mcp?client=${esc(c.id)}">Call history</a> ${c.revoked_at?'':action('/api/crank/mcp-clients/'+encodeURIComponent(c.id)+'/revoke','Revoke client',{return_to:'/app/settings/mcp'},'secondary')}</li>`).join('')}</ul>`:'<p>No client servers created.</p>'}</section>
    ${selected?`<section class="panel"><h2>Client call history</h2>${calls.length?`<ul class="list">${calls.map(c=>`<li class="history-item"><strong>${esc(c.tool)}</strong> ${chip(c.status)}<p>${timestamp(c.created_at)}${c.reason?' · '+esc(c.reason):''}</p>${c.run_id?`<a href="/app/workflow-runs/${esc(c.run_id)}">Inspect inputs, output and provider IDs</a>`:''}</li>`).join('')}</ul>`:'<p>No calls recorded.</p>'}</section>`:''}`
}

export function mcpCredentialView(client: any) {
  return `<section class="panel"><h2>${esc(client.label)}</h2><p>Shown once. Store this secret in your AI client's private connection settings.</p><label>Server URL<input readonly aria-label="Server URL" value="${esc(client.url)}"></label><label>Client secret<input type="password" autocomplete="off" readonly aria-label="Client secret" value="${esc(client.credential)}"></label><p>Use the secret as a Bearer authorization header. Only this server accepts it.</p><a class="btn btn-secondary" href="/app/settings/mcp">Return to client servers</a></section>`
}
