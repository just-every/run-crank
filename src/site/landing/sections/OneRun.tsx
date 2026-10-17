import { AppTile, Check, glued, SectionHead } from '../parts'
import { mapping, run, runSteps } from '../week'

/** Tuesday, 9:14 AM: the hero's payment through every step, with the field mapping the overnight repair changes. */
export function OneRun() {
  const label = `Run #${run.number}, ${run.workflow.join(' to ')}, ${runSteps.length} steps: ${runSteps.map(s => `${s.title}, ${s.lines.join(' ')}${s.note ? `, ${s.note}` : ''}, at ${s.time}`).join('; ')}. Field mapping: ${mapping.map(m => `${m.from} to ${m.to}`).join('; ')}.`
  return <section id="one-run" className="sec one-run" aria-labelledby="one-run-title">
    <div className="site-wrap wide-wrap">
      <SectionHead id="one-run" eyebrow="Tuesday, 9:14 AM" title="One payment, every step." className="centered">{run.customer} pays {run.amount}. This is what Crank did with it.</SectionHead>
      <div className="run-art" role="img" aria-label={label}>
        <div aria-hidden="true">
          <div className="card glow run-card">
            <p className="run-head"><strong>Run #{run.number}</strong><span className="sep">·</span><span className="run-flow">{run.workflow[0]} → {run.workflow[1]}</span><span className="sep">·</span><span className="run-count">{runSteps.length} steps</span></p>
            <ol className="run-steps">{runSteps.map(step => <li key={step.title} className="run-step">
              <AppTile app={step.app} />
              <h3>{step.title}</h3>
              <p className="run-lines">{step.lines.map(line => <span key={line}>{glued(line)}</span>)}</p>
              {step.note && <p className="chip chip-warm run-note">{glued(step.note)}</p>}
              <p className="run-foot"><time>{step.time}</time><Check /></p>
            </li>)}</ol>
          </div>
          <div className="card map-strip">
            <h3>Field mapping</h3>
            <ul>{mapping.map(m => <li key={m.from}><code>{m.from}</code><span className="map-arrow">→</span><code className="map-to">{m.to}</code></li>)}</ul>
          </div>
        </div>
      </div>
    </div>
  </section>
}
