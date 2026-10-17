import type { CSSProperties } from 'react'
import { Actions } from '../shell/Actions'
import { AppTile, Check, Dot, Icon, Painting } from './parts'

type Step = { app: 'stripe' | 'sheets' | 'slack' | 'quickbooks'; title: string; detail?: string; status: 'Triggered' | 'Completed'; time: string; box: [number, number, number] }

// One run riding the machine, at the painted cards' places on the 1536 x 1024 desk art (x, y, width).
const STEPS: Step[] = [
  { app: 'stripe', title: 'New Stripe payment', detail: '$480.00', status: 'Triggered', time: '9:14 AM', box: [337, 526, 234] },
  { app: 'sheets', title: 'Add row to\nGoogle Sheets', status: 'Completed', time: '9:14 AM', box: [596, 546, 219] },
  { app: 'slack', title: 'Post in #sales\non Slack', status: 'Completed', time: '9:14 AM', box: [841, 554, 214] },
  { app: 'quickbooks', title: 'Create invoice in\nQuickBooks', status: 'Completed', time: '9:15 AM', box: [1081, 552, 210] },
]
const at = ([x, y, w]: [number, number, number]) => ({ '--x': x, '--y': y, '--w': w }) as CSSProperties

function StepCard({ step }: { step: Step }) {
  return <div className="hero-card step-card">
    <div className="step-card-head"><AppTile app={step.app} /><p><span className="step-title">{step.title}</span>{step.detail && <span className="step-detail">{step.detail}</span>}</p></div>
    <p className="step-card-foot">{step.status === 'Triggered' ? <Dot /> : <Check />}<span>{step.status}</span><time>{step.time}</time></p>
  </div>
}

const Repaired = () => <div className="hero-card repaired-card">
  <span className="repair-icon"><Icon name="replay" /></span>
  <p><span className="repaired-title">Field renamed: amount → amount_total</span><span className="repaired-detail">Repaired, re-tested <span className="tick-text">✓</span></span></p>
</div>

const Counter = () => <div className="hero-counter"><span>Runs today</span><strong>1,284</strong><span><Dot />0 failed</span></div>

/** The painted lakeside machine, the promise and the actions, with today's run riding the machine as real cards. */
export function Hero() {
  return <section className="hero" aria-labelledby="hero-title">
    <div className="hero-copy">
      <h1 id="hero-title">The busywork runs itself.</h1>
      <p className="hero-sub">Crank connects your apps, runs every step on schedule, retries what fails, and fixes the mapping when an app changes.</p>
      <p className="hero-alt">100% free, open source alternative to <strong>Zapier</strong>, <strong>Make</strong> and <strong>Workato</strong></p>
      <Actions />
    </div>
    <div className="hero-phone-cards site-wrap" aria-hidden="true">
      <div className="hero-phone-steps">{STEPS.map(step => <StepCard key={step.app} step={step} />)}</div>
      <Repaired />
    </div>
    <div className="hero-stage">
      <Painting className="hero-art" name="hero" widths={[768, 1152, 1536]} sizes="100vw" eager phone={{ name: 'hero-phone', widths: [780, 1170], media: '(max-width: 760px)' }} />
      <div className="hero-machine" role="img" aria-label="A Crank run: a new Stripe payment of $480.00 at 9:14 AM adds a row to Google Sheets, posts in #sales on Slack and creates an invoice in QuickBooks at 9:15 AM; a renamed field was repaired and re-tested; 1,284 runs today, 0 failed.">
        <div aria-hidden="true">
          {STEPS.map(step => <div key={step.app} className="on-machine" style={at(step.box)}><StepCard step={step} /></div>)}
          <div className="on-machine repaired-at" style={at([552, 763, 386])}><Repaired /></div>
          <div className="on-machine counter-at" style={at([1326, 667, 134])}><Counter /></div>
        </div>
      </div>
    </div>
  </section>
}
