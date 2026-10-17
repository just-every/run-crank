import { AppTile, Check, Dot, glued, Icon, SectionHead } from '../parts'
import { log, today, type LogTone } from '../week'

const Status = ({ tone, text }: { tone: LogTone; text: string }) => <span className={`chip chip-${tone}`}>
  {tone === 'done' ? <Check /> : <Icon name={tone === 'skipped' ? 'minus' : 'alert'} />}{text}
</span>

/** Tuesday, all day: eight of the day's runs, each started by its own trigger. */
export function AllDay() {
  return <section id="all-day" className="sec all-day" aria-labelledby="all-day-title">
    <div className="site-wrap all-day-row">
      <SectionHead id="all-day" eyebrow="Tuesday, all day" title="Nobody presses go.">Schedules, new emails, webhooks and app events start every run. Duplicates are caught before they run twice.</SectionHead>
      <div className="card glow log-card" role="img" aria-label={`Today, ${today.runs} runs, ${today.lost} lost: ${log.map(r => `${r.time}, ${r.text}, ${r.status}`).join('; ')}. Showing 8 of ${today.runs}.`}>
        <div aria-hidden="true">
          <p className="log-head"><strong>Today · {today.runs} runs</strong><span className="log-lost"><Dot />{today.lost} lost</span></p>
          <ul className="log-list">{log.map(row => <li key={row.time + row.text} className={`log-row tone-${row.tone}`}>
            <time>{row.time}</time><AppTile app={row.app} /><span className="log-text">{glued(row.text)}</span><Status tone={row.tone} text={row.status} />
          </li>)}</ul>
          <p className="log-foot">Showing 8 of {today.runs}</p>
        </div>
      </div>
    </div>
  </section>
}
