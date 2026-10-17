import { AppTile, Check, Feature, Icon } from '../parts'

/** Desk page 6, top: self-repair when an app changes its data. */
export function SelfRepair() {
  return <Feature id="self-repair" eyebrow="Self-repair" title={<>Apps change. Crank keeps up.</>} label="HubSpot's API changed on Oct 15 at 10:31 AM: deal.amount became deal.amount_total. The mapping was repaired in Update HubSpot deal, tested on the last 20 runs with 20 passing, and the workflow resumed at 10:42 AM; 2 unsure updates were checked in HubSpot and both landed." art={
    <div className="card repair-card">
      <h3 className="repair-head"><AppTile app="hubspot" /><span><strong>HubSpot API changed</strong> · Oct 15, 10:31 AM</span></h3>
      <div className="diff"><p className="diff-old"><span>−</span><code>deal.amount</code></p><p className="diff-new"><span>+</span><code>deal.amount_total</code></p></div>
      <ul className="repair-list">
        <li><Check />Mapping repaired in Update HubSpot deal</li>
        <li><Check />Tested on last 20 runs · 20 passed</li>
        <li><Check />Workflow resumed 10:42 AM</li>
      </ul>
      <p className="repair-note"><Icon name="info" />2 unsure updates checked in HubSpot · both landed</p>
    </div>
  }>When an app renames a field or changes its data, Crank's agent repairs the mapping, tests it on recent runs and puts the workflow back.</Feature>
}

const IMPORTED = [
  { what: 'Zaps', count: '46 rebuilt' },
  { what: 'n8n workflows', count: '12 rebuilt' },
  { what: 'Connections', count: '18 reconnected' },
  { what: 'Side-by-side runs', count: '312 matched' },
]

/** Desk page 6, bottom: move in from Zapier, Make or n8n. */
export function MoveIn() {
  return <Feature id="move-in" flip eyebrow="Move in" title={<>Bring your Zaps<br />with you.</>} label="Importing from Zapier and n8n, 100% done: 46 Zaps and 12 n8n workflows rebuilt, 18 connections reconnected, 312 side-by-side runs matched; a Formatter step was converted to a code step." art={
    <div className="card import-card">
      <h3 className="import-head"><AppTile app="zapier" /><AppTile app="n8n" /><span>Importing from Zapier and n8n</span></h3>
      <p className="progress"><span className="progress-bar"><span /></span><span>100%</span></p>
      <ul className="import-list">{IMPORTED.map(i => <li key={i.what}><Check /><span>{i.what}</span><span className="import-count">{i.count}</span></li>)}</ul>
      <p className="import-note"><Icon name="alert" /><span>Formatter step converted to a code step <span className="tick-text">✓</span></span></p>
    </div>
  }>Import from Zapier, Make or n8n. Crank rebuilds each workflow, reconnects your apps and runs it beside the old one until the results match.</Feature>
}
