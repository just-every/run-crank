import { action, chip, esc, json, parse, timestamp } from './document'
export function runView(state:any,id:string) {
  const r = state.runs.find((r:any)=>r.id===id)
  if (!r) return '<div class="empty-state"><h3>Run not found, or it has been erased.</h3><a class="btn btn-secondary" href="/app/runs">All runs</a></div>'
  const owner = state.actor.role==='owner', f = state.flows.find((f:any)=>f.id===r.flow_id)
  const decisions = state.approvals.filter((a:any)=>a.run_id===id), attempts = state.attempts.filter((a:any)=>a.run_id===id)
  const expired = r.state==='running' && Date.parse(r.lease_expires_at)<Date.now()
  return `<p class="back-link"><a href="/app/runs">← All runs</a></p><div class="detail-layout"><section class="panel detail-primary">
    <div class="title-row"><h2>${esc(r.event_id)}</h2>${chip(r.state)}</div>
    <dl class="facts"><dt>Source</dt><dd>${esc(r.source_app)}</dd><dt>Destination</dt><dd>${esc(r.destination_app)}<br><code>${esc(r.target_url)}</code></dd><dt>Flow revision</dt><dd>${esc(r.flow_revision)}</dd><dt>Delivery key</dt><dd><code>${esc(r.id)}</code></dd></dl>
    <h3>Exact input sent on approval</h3><pre>${json(parse(r.input_json))}</pre><p class="muted">The same body and delivery key are used for a replay. A destination acknowledgement confirms receipt; it does not certify any later business action.</p>
    ${owner&&r.state==='pending'?`<div class="actions">${action(`/api/crank/runs/${id}/approve`,'Approve and deliver')}${action(`/api/crank/runs/${id}/reject`,'Reject',{},'secondary')}</div>`:''}
    ${owner&&((r.state==='failed')||expired)&&r.replay_count===0?`<p class="notice">Check the destination before replaying. Crank will make one more attempt using this approved input.</p><div class="actions">${action(`/api/crank/runs/${id}/replay`,'Replay once')}</div>`:''}
  </section><div class="detail-side">
    <section class="panel"><h2>Approval history</h2>${decisions.length?decisions.map((a:any)=>`<article class="history-item"><strong>${esc(a.decision)}</strong><p>Person ${esc(a.actor_id)} · ${timestamp(a.created_at)}</p><p>Reviewed action fingerprint <code>${esc(a.action_digest)}</code></p></article>`).join(''):'<p class="muted">Awaiting an owner’s decision. Nothing has been sent.</p>'}</section>
    <section class="panel"><h2>Delivery attempts</h2>${attempts.length?attempts.map((a:any)=>`<article class="history-item"><h3>Attempt ${esc(a.number)}</h3><p>${timestamp(a.started_at)}${a.finished_at?` → ${timestamp(a.finished_at)}`:''}</p><pre>${json(parse(a.outcome_json))}</pre></article>`).join(''):'<p class="muted">No delivery attempts.</p>'}</section>
  </div></div>
  ${owner&&['succeeded','failed','rejected'].includes(r.state)?`<section class="panel danger-zone"><h2>Erase this run</h2><p>Removes its input, decision and attempts from Crank, invalidates local transfer snapshots and prevents the old archive from restoring it here. Existing effects at the destination remain there.</p>${f?.status==='active'?'<p class="muted">Pause this flow on the Flows page first.</p>':action('/api/crank/data/erase','Erase run and its data',{run_id:id,confirm:'ERASE'},'danger')}</section>`:''}`
}
