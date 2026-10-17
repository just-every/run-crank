import { links } from '../../shell/links'
import run from '../../run.json'
import { Icon } from '../parts'

const OWNED = [
  { icon: 'monitor', text: 'Your own computer or server' },
  { icon: 'key', text: 'Your keys stay with you' },
  { icon: 'upload', text: 'Export any time' },
]

/** Desk page 7: ownership, and the one line that starts Crank on your own computer. */
export function Ownership() {
  return <section id="ownership" className="ownership" aria-labelledby="ownership-title">
    <div className="site-wrap ownership-row">
      <div className="ownership-copy">
        <p className="eyebrow">Ownership</p>
        <h2 id="ownership-title">Yours,<br />start to finish.</h2>
        <p className="feature-body"><a href={links.run}>Run Crank</a> on your own computer or server and keep every workflow, connection and run log. Export everything, any time.</p>
        <ul className="owned">{OWNED.map(o => <li key={o.icon}><Icon name={o.icon} />{o.text}</li>)}</ul>
      </div>
      <div className="terminal" aria-label="Start Crank on your computer">
        <div className="terminal-bar" aria-hidden="true"><span /><span /><span /></div>
        <pre><code><span className="prompt" aria-hidden="true">$ </span>{run.clone}{'\n'}<span className="comment"># clones, installs and starts Crank on your computer</span></code></pre>
      </div>
    </div>
  </section>
}
