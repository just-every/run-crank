import { AppTile, Check, Icon } from '../parts'
import { Feature } from '../parts'

const CONNECTIONS = [
  { app: 'gmail', name: 'Gmail', account: 'ops@northwindgoods.example' },
  { app: 'slack', name: 'Slack', account: 'Northwind Goods' },
  { app: 'sheets', name: 'Google Sheets', account: 'Orders 2026' },
  { app: 'stripe', name: 'Stripe', account: 'Live account' },
  { app: 'quickbooks', name: 'QuickBooks', account: 'Northwind Goods LLC' },
] as const

/** Desk page 2, top: the connector library, every sign-in kept fresh. */
export function Connectors() {
  return <Feature id="connectors" eyebrow="Connectors" title={<>Every app you already use.</>} label="Connections: Gmail, Slack, Google Sheets, Stripe and QuickBooks, each connected; a QuickBooks sign-in expired at 6:12 AM and was renewed automatically." art={
    <div className="card connections-card">
      <h3 className="card-title">Connections</h3>
      <ul className="connection-list">{CONNECTIONS.map(c => <li key={c.name}>
        <AppTile app={c.app} /><p><strong>{c.name}</strong><span>{c.account}</span></p><span className="chip chip-green"><Check />Connected</span>
      </li>)}</ul>
      <p className="renewed"><Check /><span>Sign-in expired 6:12 AM · renewed automatically <span className="tick-text">✓</span></span></p>
    </div>
  }>Gmail, Slack, Google Sheets, HubSpot, Salesforce, QuickBooks, Stripe and Shopify. Sign in once and Crank keeps every connection fresh.</Feature>
}

const EVENTS = [
  { invoice: 'Invoice #1182', from: 'Harbor Supply Co.', time: '9:02 AM', started: true },
  { invoice: 'Invoice #1183', from: 'Pine Street Print', time: '9:03 AM', started: true },
  { invoice: 'Invoice #1182', from: 'Harbor Supply Co.', time: '9:04 AM', started: false },
]

/** Desk page 2, bottom: triggers, with the duplicate caught. */
export function Triggers() {
  return <Feature id="triggers" flip eyebrow="Triggers" title={<>Starts on its own.</>} label="New email in Gmail with the label Invoices: invoice 1182 from Harbor Supply Co. started a run at 9:02 AM, invoice 1183 from Pine Street Print at 9:03 AM, and invoice 1182 again at 9:04 AM was skipped as a duplicate. Also every weekday at 9:00 AM Eastern." art={
    <div className="card trigger-card">
      <h3 className="card-title trigger-title"><AppTile app="gmail" />New email in Gmail · label: Invoices</h3>
      <ul className="trigger-list">{EVENTS.map(e => <li key={e.time}>
        <p><span><strong>{e.invoice}</strong> · {e.from}</span><time>{e.time}</time></p>
        {e.started ? <span className="chip chip-green chip-lg"><Check />Started</span> : <span className="chip chip-grey chip-lg"><Icon name="minus" />Duplicate · skipped</span>}
      </li>)}</ul>
      <p className="trigger-schedule"><Icon name="clock" />Also every weekday at 9:00 AM ET</p>
    </div>
  }>Run on a schedule, a new email, a form, a webhook or any app event. Duplicates are caught before they run twice.</Feature>
}
