import { action, chip, esc, hidden, timestamp } from './document'
export function flowsView(state:any, target:string) {
  const owner = state.actor.role === 'owner', prepare = ['owner','admin'].includes(state.actor.role)
  const flows = [...state.flows].sort((a:any,b:any)=>Number(b.status==='active')-Number(a.status==='active'))
  const primary = flows.findIndex((flow:any)=>flow.status==='active')
  return `<p class="page-intro">Connect an incoming event to one HTTP destination. Every event waits for an owner’s decision.</p>
  <section class="flow-list" aria-label="Your flows"><h2>Your flows</h2>${flows.length?flows.map((f:any,index:number)=>`
    <article class="flow-card ${index===primary?'metal-plate':'plain-card'}"><div class="flow-content ${index===primary?'metal-slot':''}">
      <div class="title-row"><h3>${esc(f.name)}</h3>${chip(f.status)}</div>
      <p>${esc(f.source_app)} → Human approval → ${esc(f.destination_app)}</p>
      <p class="mono flow-url">${esc(f.target_url)}</p>
      <p class="flow-id">Flow ID <code>${esc(f.id)}</code></p>
      <div class="actions flow-actions">${owner?action(`/api/crank/flows/${f.id}/${f.status==='active'?'pause':'activate'}`,f.status==='active'?'Pause flow':'Activate flow'):''}<a href="/app/runs?flow=${esc(f.id)}">View runs</a></div>
      ${f.status==='active'&&prepare?`<details><summary>Prepare a run</summary><form method="post" action="/app/action">${hidden('path',`/api/crank/flows/${f.id}/runs`)}
        <label>Event ID<input name="event_id" required maxlength="128" placeholder="ticket-1042"></label>
        <label>Event input (JSON object)<textarea name="input" required rows="5" placeholder='{"customer":"Harbour Workshop","task":"Book a callback"}'></textarea></label>
        <button class="dark-pill">Prepare for approval</button></form></details>`:''}
    </div></article>`).join(''):`<article class="plain-card empty-state"><h3>No flows yet</h3><p>Create your first flow below. Start the Operations inbox from the README for a local destination.</p></article>`}
  </section>
  ${prepare?`<section class="plain-card create-flow"><h2>Create a flow</h2><form method="post" action="/app/action">${hidden('path','/api/crank/flows')}
    <div class="grid"><label>Flow name<input name="name" required maxlength="100" placeholder="Support follow-up"></label><label>Source app<input name="source_app" required maxlength="100" placeholder="Support desk"></label><label>Destination app<input name="destination_app" required maxlength="100" placeholder="Operations inbox"></label><label>Destination URL<input name="target_url" type="url" required value="${esc(target)}/events"></label></div>
    <p class="form-help">Activation requires an owner. The destination must preserve Idempotency-Key and acknowledge it in its response.</p><button class="crank-key">Create draft flow</button>
  </form></section>`:''}`
}
export function runsView(state:any, flow:string|null) {
  const rows = state.runs.filter((r:any)=>!flow || r.flow_id===flow).sort((a:any,b:any)=>Number(b.state==='pending')-Number(a.state==='pending'))
  return `<p class="page-intro">Review inputs, approve an action, then follow its delivery. Failed delivery may be replayed once.</p>${rows.length?`<div class="run-list">${rows.map((r:any)=>`
    <article class="plain-card"><div class="title-row"><h2><a href="/app/runs/${esc(r.id)}">${esc(r.event_id)}</a></h2>${chip(r.state)}</div>
      <p>${esc(r.source_app)} → ${esc(r.destination_app)}</p><p class="run-note">${timestamp(r.created_at)} · ${r.replay_count?'Replay used':r.state==='failed'?'One replay available':r.state==='pending'||r.state==='running'?'Awaiting outcome':'Delivery closed'}</p>
    </article>`).join('')}</div>`:`<section class="plain-card empty-state"><h2>No runs yet</h2><p>Activate a flow, then prepare its first event from the Flows page.</p><a href="/app">Open flows</a></section>`}`
}
