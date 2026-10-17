import { Check, Dot, glued, Icon, Mark, Painting } from '../parts'
import { agentLog, answer, business, type AgentTone } from '../week'

const RowMark = ({ tone }: { tone: AgentTone }) => tone === 'done' ? <Check />
  : tone === 'failed' ? <Dot tone="red" />
  : tone === 'asked' ? <Dot tone="amber" />
  : <Icon name={tone === 'read' ? 'book' : 'pencil'} className={`agent-icon agent-${tone}`} />

/** Overnight: the lakeside village at night carries the agent's record of an API change, repaired and tested. */
export function Overnight() {
  return <section id="overnight" className="overnight" aria-labelledby="overnight-title">
    <Painting className="night-art" name="night" widths={[768, 1152, 1536, 2304, 3072]} sizes="100vw" phone={{ name: 'night-phone', widths: [780, 1170, 1560], media: '(max-width: 1180px)' }} />
    <div className="night-copy site-wrap">
      <p className="kicker">Overnight</p>
      <h2 id="overnight-title">Apps change. Crank keeps up.</h2>
      <p className="sec-body">Its agent repairs the mapping, tests it, and asks a person only for a business choice.</p>
    </div>
    <div className="night-card-wrap site-wrap">
      <div className="card agent-card" role="img" aria-label={`Agent log for Stripe to QuickBooks invoice: ${agentLog.map(r => `${r.time}, ${r.text}${r.diff ? `, ${r.diff[0]} replaced by ${r.diff[1]}` : ''}`).join('; ')}. ${business.owner} answered “${answer.text}” at ${answer.time}.`}>
        <div aria-hidden="true">
          <h3 className="agent-title"><Mark className="mark agent-mark" /><span>Agent log · Stripe → QuickBooks invoice</span></h3>
          <ol className="agent-list">{agentLog.map(row => <li key={row.time} className={`agent-row tone-${row.tone}`}>
            <time>{row.time}</time><span className="agent-mark-cell"><RowMark tone={row.tone} /></span>
            <p><span>{glued(row.text)}</span>{row.diff && <span className="diff"><code className="diff-old">− {row.diff[0]}</code><code className="diff-new">+ {row.diff[1]}</code></span>}</p>
          </li>)}</ol>
          <p className="agent-answer"><span className="avatar">{business.initials}</span><span className="bubble">{answer.text}</span><time>{answer.time}</time></p>
        </div>
      </div>
    </div>
  </section>
}
