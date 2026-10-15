import { action, chip, esc, json, parse, timestamp } from './document'
export function runView(state:any,id:string) {
  const r = state.runs.find((r:any)=>r.id===id)
  if (!r) return '<p>Run not found, or it has been erased.</p><a href="/app/runs">All runs</a>'
  const owner = state.actor.role==='owner', f = state.flows.find((f:any)=>f.id===r.flow_id)
  const decisions = state.approvals.filter((a:any)=>a.run_id===id), attempts = state.attempts.filter((a:any)=>a.run_id===id)
  const expired = r.state==='running' && Date.parse(r.lease_expires_at)<Date.now()
  return `<p class="back-link"><a href="/app/runs">← All runs</a></p><div class="run-layout"><section class="metal-plate run-primary"><div class="metal-slot">
    <div class="title-row"><h2>${esc(r.event_id)}</h2>${chip(r.state)}</div>
    <dl><dt>Source</dt><dd>${esc(r.source_app)}</dd><dt>Destination</dt><dd>${esc(r.destination_app)}<br><code>${esc(r.target_url)}</code></dd><dt>Flow revision</dt><dd>${esc(r.flow_revision)}</dd><dt>Delivery key</dt><dd><code>${esc(r.id)}</code></dd></dl>
    <h3>Exact input sent on approval</h3><pre>${json(parse(r.input_json))}</pre><p>The same body and delivery key are used for a replay. A destination acknowledgement confirms receipt; it does not certify any later business action.</p>
    ${owner&&r.state==='pending'?`<div class="actions">${action(`/api/crank/runs/${id}/approve`,'Approve and deliver',{},'crank-key')}${action(`/api/crank/runs/${id}/reject`,'Reject',{},'secondary')}</div>`:''}
    ${owner&&((r.state==='failed')||expired)&&r.replay_count===0?`<p>Check the destination before replaying. Crank will make one more attempt using this approved input.</p>${action(`/api/crank/runs/${id}/replay`,'Replay once',{},'crank-key')}`:''}
  </div></section><div class="run-history">
    <section class="plain-card"><h2>Approval history</h2>${decisions.length?decisions.map((a:any)=>`<article><strong>${esc(a.decision)}</strong><p>Person ${esc(a.actor_id)} · ${timestamp(a.created_at)}</p><p>Reviewed action fingerprint <code>${esc(a.action_digest)}</code></p></article>`).join(''):'<p>Awaiting an owner’s decision. Nothing has been sent.</p>'}</section>
    <section class="plain-card"><h2>Delivery attempts</h2>${attempts.length?attempts.map((a:any)=>`<article><h3>Attempt ${esc(a.number)}</h3><p>${timestamp(a.started_at)}${a.finished_at?` → ${timestamp(a.finished_at)}`:''}</p><pre>${json(parse(a.outcome_json))}</pre></article>`).join(''):'<p>No delivery attempts.</p>'}</section>
  </div></div>
  ${owner&&['succeeded','failed','rejected'].includes(r.state)?`<section class="plain-card erase-card"><h2>Erase this run</h2><p>Removes its input, decision and attempts from Crank, invalidates local transfer snapshots and prevents the old archive from restoring it here. Existing effects at the destination remain there.</p>${f?.status==='active'?'<p>Pause this flow on the Flows page first.</p>':action('/api/crank/data/erase','Erase run and its data',{run_id:id,confirm:'ERASE'},'danger')}</section>`:''}`
}
