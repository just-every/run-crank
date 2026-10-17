import run from '../../run.json'
import { AppTile, Check, Icon, Mark, SectionHead } from '../parts'
import { business, imported, importTotals, type Imported } from '../week'

/** The machine object perched on the terminal: a faceless brass gear with a wooden-and-brass crank handle. */
const Vignette = () => <svg className="vignette" viewBox="0 0 120 110" aria-hidden="true">
  <defs>
    <radialGradient id="vg-brass" cx="40%" cy="35%" r="70%"><stop offset="0" stopColor="#ffe08a" /><stop offset=".55" stopColor="#e2a42a" /><stop offset="1" stopColor="#9a6410" /></radialGradient>
    <linearGradient id="vg-wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f0a35a" /><stop offset=".5" stopColor="#c86e28" /><stop offset="1" stopColor="#8a4515" /></linearGradient>
    <linearGradient id="vg-arm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#c78a1c" /><stop offset=".5" stopColor="#ffd56a" /><stop offset="1" stopColor="#a8700f" /></linearGradient>
  </defs>
  <ellipse cx="44" cy="104" rx="34" ry="5" fill="rgba(4,14,40,.35)" />
  <g transform="translate(44 70)">
    {Array.from({ length: 12 }, (_, i) => <rect key={i} x="-5" y="-35" width="10" height="11" rx="2" fill="#c98c1e" stroke="#7a4d08" strokeWidth="1.2" transform={`rotate(${i * 30})`} />)}
    <circle r="27" fill="url(#vg-brass)" stroke="#7a4d08" strokeWidth="1.6" />
    <circle r="17" fill="none" stroke="#a46d12" strokeWidth="2" />
    {Array.from({ length: 6 }, (_, i) => <circle key={i} cx="0" cy="-11.5" r="2.6" fill="#8d5a0c" transform={`rotate(${i * 60})`} />)}
    <circle r="6.5" fill="#f6cf6a" stroke="#7a4d08" strokeWidth="1.4" />
  </g>
  <path d="M44 70 L62 30" stroke="#7a4d08" strokeWidth="9" strokeLinecap="round" />
  <path d="M44 70 L62 30" stroke="url(#vg-arm)" strokeWidth="6.5" strokeLinecap="round" />
  <circle cx="62" cy="30" r="5" fill="#f6cf6a" stroke="#7a4d08" strokeWidth="1.4" />
  <rect x="62" y="20" width="50" height="17" rx="8.5" fill="url(#vg-wood)" stroke="#6e3810" strokeWidth="1.4" transform="rotate(-14 62 28)" />
  <path d="M70 23.5 Q88 19 104 19.5" stroke="rgba(255,236,200,.65)" strokeWidth="2" fill="none" strokeLinecap="round" transform="rotate(-14 62 28)" />
</svg>

const Pair = ({ row }: { row: Imported }) => <span className="pair"><AppTile app={row.from} /><span className="pair-arrow">→</span><AppTile app={row.to} /></span>

function ImportRow({ row }: { row: Imported }) {
  return <li className={row.question ? 'asks' : undefined}>
    <Pair row={row} />
    <p className="imp-name">{row.trigger} →<br /> {row.action}</p>
    <span className="imp-meta">
      <span className="imp-steps">{row.steps}<span className="imp-steps-unit"> steps</span></span>
      <span className="imp-rebuilt">{row.question ? <span className="chip chip-warm"><Icon name="alert" />Needs you</span> : <><Check className="check soft-check" />{row.note && <small>{row.note}</small>}</>}</span>
      <span className="imp-match">{row.matched ? `${row.matched[0]} of ${row.matched[1]} match` : <span className="imp-none">—</span>}</span>
    </span>
    {row.question && <p className="imp-question"><Icon name="alert" />{row.question}</p>}
  </li>
}

/** Monday morning: the Zapier export moves in, each workflow checked against its past runs. */
export function MoveIn() {
  // The clone URL may break after the host, never inside the repository name.
  const { origin, pathname } = new URL(run.repository)
  return <section id="move-in" className="sec move-in" aria-labelledby="move-in-title">
    <div className="site-wrap move-in-row">
      <div className="move-in-copy">
        <SectionHead id="move-in" eyebrow="Monday morning" title={<>Move in<br /> before lunch.</>}>Give Crank your Zapier, Make or Workato export. It rebuilds each workflow and runs it beside the old one until the results match.</SectionHead>
        <div className="terminal">
          <Vignette />
          <div className="terminal-bar" aria-hidden="true"><span /><span /><span /></div>
          <pre><code>
            <span className="t-line"><span className="prompt" aria-hidden="true">$ </span>git clone {origin}/<wbr /><span className="t-url">{pathname.slice(1)}.git</span> crank</span>
            <span className="t-line"><span className="prompt" aria-hidden="true">$ </span>cd crank && rer dev</span>
            <span className="t-line t-ok"><span aria-hidden="true">✓ </span>Crank is running</span>
          </code></pre>
        </div>
      </div>
      <div className="card glow import-card" role="img" aria-label={`Import from Zapier for ${business.name}: ${imported.map(r => `${r.trigger} to ${r.action}, ${r.steps} steps, ${r.matched ? `rebuilt, ${r.matched[0]} of ${r.matched[1]} past runs match` : `needs you: ${r.question}`}`).join('; ')}. ${importTotals.zaps} Zaps, ${importTotals.running} running side by side, ${importTotals.questions} question for you.`}>
        <div aria-hidden="true">
          <h3 className="import-title"><Mark className="mark import-mark" /><span>Import from Zapier · {business.name}</span></h3>
          <div className="imp-cols"><span className="imp-col-flow">Workflow</span><span>Steps</span><span>Rebuilt</span><span>Past runs checked</span></div>
          <ul className="imp-list">{imported.map(row => <ImportRow key={row.trigger} row={row} />)}</ul>
          <p className="imp-foot"><span>{importTotals.zaps} Zaps</span><span>{importTotals.running} running side by side</span><span>{importTotals.questions} question for you</span></p>
        </div>
      </div>
    </div>
  </section>
}
