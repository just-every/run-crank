import { AppTile, ArrowDown, Check, Feature, Icon } from '../parts'

const MAP = [
  { from: 'customer.email', to: 'Contact email' },
  { from: 'amount ÷ 100', to: 'Amount (USD)' },
  { from: 'metadata.company', to: 'Account name' },
]

/** Desk page 3, top: the builder, a branch and a field map. */
export function Builder() {
  return <Feature id="builder" eyebrow="Builder" title={<>Build it step by step.</>} label="A workflow: Stripe new payment, then a branch on amount over $1,000: yes creates a Salesforce opportunity, no adds a Google Sheets row. Its field map sends customer.email to Contact email, amount divided by 100 to Amount (USD), metadata.company to Account name, and a missing company to Individual." art={
    <div className="builder-art">
      <div className="card flow-card">
        <div className="flow-node flow-trigger"><AppTile app="stripe" /><span><strong>Stripe</strong> · New payment</span></div>
        <ArrowDown />
        <div className="flow-branch">
          <span className="flow-diamond"><Icon name="dollar" /></span><span className="flow-question">Amount over $1,000?</span>
        </div>
        <div className="flow-paths">
          <svg className="flow-lines" viewBox="0 0 400 110" preserveAspectRatio="none"><path d="M197 2H120a16 16 0 0 0-16 16v88M280 26v80" /><path d="m100 100 4 6 4-6M276 100l4 6 4-6" /></svg>
          <span className="flow-yes">Yes</span><span className="flow-no">No</span>
        </div>
        <div className="flow-ends">
          <div className="flow-node"><AppTile app="salesforce" /><span><strong>Salesforce</strong><small>Create opportunity</small></span></div>
          <div className="flow-node"><AppTile app="sheets" /><span><strong>Google Sheets</strong><small>Add row</small></span></div>
        </div>
      </div>
      <span className="flow-dots" />
      <div className="card map-card">
        <h3 className="card-title">Map fields</h3>
        <ul className="map-list">
          {MAP.map(m => <li key={m.from}><code>{m.from}</code><span className="map-arrow">→</span><span className="map-to">{m.to}</span></li>)}
          <li className="map-missing"><span className="map-warn"><Icon name="warning" />company missing</span><span className="map-arrow">→</span><span className="map-to">Individual</span></li>
        </ul>
      </div>
    </div>
  }>Map fields, filter, branch, loop and wait, or drop in a code step. Save any piece as a subflow and use it again.</Feature>
}

const RUN = [
  { app: 'stripe', name: 'Stripe', step: 'Get payment', time: '0.4s' },
  { app: 'code', name: '', step: 'Format invoice', time: '0.1s' },
  { app: 'quickbooks', name: 'QuickBooks', step: 'Create invoice', time: '31.2s', note: 'Rate limited · retried after 30s · succeeded' },
  { app: 'gmail', name: 'Gmail', step: 'Send receipt', time: '0.8s' },
] as const

/** Desk page 3, bottom: reliable runs, a rate-limited step retried. */
export function ReliableRuns() {
  return <Feature id="reliable-runs" flip eyebrow="Reliable runs" title={<>Nothing gets dropped.</>} label="Run 48,213 of Stripe to QuickBooks on Oct 14 at 2:31 PM: Stripe get payment 0.4 seconds, format invoice 0.1 seconds, QuickBooks create invoice 31.2 seconds after it was rate limited and retried after 30 seconds, Gmail send receipt 0.8 seconds; every step succeeded. A Replay step button." art={
    <div className="card run-card">
      <h3 className="run-head"><strong>Run #48,213</strong><span>·</span><span>Stripe to QuickBooks</span><span>·</span><span>Oct 14, 2:31 PM</span></h3>
      <ol className="run-steps">{RUN.map(r => <li key={r.step} className={'note' in r ? 'retried' : undefined}>
        <Check /><AppTile app={r.app} /><p><span>{r.name && <>{r.name} <i>·</i> </>}{r.step}</span>{'note' in r && <small>{r.note}</small>}</p><time>{r.time}</time>
      </li>)}</ol>
      <span className="outline-button"><Icon name="replay" />Replay step</span>
    </div>
  }>Every run is queued and saved. Failed steps retry with backoff, rate limits are respected, and any step can be replayed.</Feature>
}
