import { Icon } from '../parts'

const DETAILS = [
  { icon: 'bell', tone: 'blue', title: 'Error alerts', body: 'Slack or email the moment a run needs you.' },
  { icon: 'bars', tone: 'amber', title: 'Rate limits', body: "Each app's limits respected automatically." },
  { icon: 'history', tone: 'green', title: 'Version history', body: 'Every edit saved, rolled back in one click.' },
  { icon: 'people', tone: 'blue', title: 'Team roles', body: 'Builders, approvers and viewers.' },
  { icon: 'lock', tone: 'amber', title: 'Secrets vault', body: 'Keys encrypted and never shown in logs.' },
  { icon: 'doc', tone: 'green', title: 'Activity log', body: 'Every run, edit and approval, recorded.' },
]

/** Desk page 8: also included, six cards. */
export function Details() {
  return <section id="details" className="details" aria-labelledby="details-title">
    <div className="site-wrap">
      <p className="eyebrow">Also included</p>
      <h2 id="details-title">The quiet details.</h2>
      <ul className="detail-grid">{DETAILS.map(d => <li key={d.title} className="card detail-card">
        <span className={`detail-icon tone-${d.tone}`}><Icon name={d.icon} /></span>
        <h3>{d.title}</h3><p>{d.body}</p>
      </li>)}</ul>
    </div>
  </section>
}
