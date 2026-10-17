import { AppTile, Check, Cross, Mark, SectionHead } from '../parts'
import { outage } from '../week'

/** Tuesday, 2:31 PM: Shopify answers 503, the backoff doubles, the queue holds and Crank tells #ops. */
export function Outage() {
  const label = `Shopify, get order: Shopify is down, ${outage.waiting} runs waiting. Attempts at ${outage.attempts.join(', ')} returned 503; at ${outage.recovered} it returned 200 OK, recovered. In #ops, Crank at ${outage.messages.map(m => `${m.time}: ${m.lines.join(' ')}`).join(' At ')}`
  return <section id="outage" className="sec outage" aria-labelledby="outage-title">
    <div className="site-wrap outage-row">
      <div className="outage-art" role="img" aria-label={label}>
        <div aria-hidden="true" className="outage-cards">
          <div className="card glow retry-card">
            <h3 className="retry-title"><AppTile app="shopify" /><strong>Shopify</strong><span className="sep">·</span>Get order</h3>
            <div className="retry-bands">
              <div className="band band-down">
                <p className="band-label"><strong>Shopify is down</strong><span className="sep">·</span>{outage.waiting} runs waiting</p>
                <ol className="attempts">{outage.attempts.map((t, i) => <li key={t} className={i === outage.attempts.length - 1 ? 'last' : undefined}><span className="pin"><Cross /></span><time>{t}</time><strong>503</strong></li>)}</ol>
              </div>
              <div className="band band-up">
                <p className="band-label"><strong>Recovered</strong> <span>{outage.recovered}</span></p>
                <ol className="attempts"><li><span className="pin"><Check /></span><time>{outage.recovered}</time><strong>200 OK</strong></li></ol>
              </div>
            </div>
          </div>
          <div className="card ops-card">
            <h3 className="ops-title"><AppTile app="slack" /><span>#ops</span></h3>
            <ul className="ops-list">{outage.messages.map(m => <li key={m.time}>
              <Mark className="mark ops-mark" />
              <div><p className="ops-who"><strong>Crank</strong><time>{m.time}</time></p>
                <p className={`ops-text${m.done ? ' done' : ''}`}>{m.done && <Check />}<span>{m.lines.map(l => <span key={l}>{l}</span>)}</span></p></div>
            </li>)}</ul>
          </div>
        </div>
      </div>
      <SectionHead id="outage" eyebrow="Tuesday, 2:31 PM" title={<>Shopify goes down.<br /> Orders wait.</>}>Failed steps retry with backoff. When an app stays down, runs wait in the queue and resume on their own, in order.</SectionHead>
    </div>
  </section>
}
