import metadata from '../../../package.json'
const repository = metadata.repository.url
import { HeroPlate } from './HeroPlate'
import { Brand, LineIcon, Plate, type LineIconName } from './Plate'
import { Section } from './Section'
import './landing.css'

type SiteLinksProps = { sourceHref?: string }

export function SiteHeader({ sourceHref = repository }: SiteLinksProps) {
  return <header className="site-header">
    <a className="site-home" href="/" aria-label="Crank home"><Brand /></a>
    <nav aria-label="Main navigation"><a href="/docs">Docs</a><a href={sourceHref}>Source</a></nav>
  </header>
}

export function SiteFooter({ sourceHref = repository }: SiteLinksProps) {
  return <footer className="site-footer">
    <a className="site-home" href="/" aria-label="Crank home"><Brand /></a>
    <p>Free and open source, MIT licensed</p>
    <nav aria-label="Footer navigation"><a href="/docs">Docs</a><a href={sourceHref}>Source</a></nav>
  </footer>
}

function RunActions() {
  return <div className="landing-actions"><a className="dark-pill landing-run-link" href="/run">Run Crank <span aria-hidden="true">→</span></a><a className="landing-docs-link" href="/docs">Read the docs</a></div>
}

const included: { label: string; icon: LineIconName }[] = [
  { label: 'Move in from n8n', icon: 'move' },
  { label: 'Export and restore', icon: 'export' },
  { label: 'Erase a run', icon: 'erase' },
  { label: 'Roles for your team', icon: 'people' },
  { label: 'Runs on your computer', icon: 'computer' },
  { label: 'Trigger keys per flow', icon: 'key' },
]

export function Landing({ variant = 'site', sourceHref = repository }: SiteLinksProps & { variant?: 'site' }) {
  return <div className="crank-landing" data-variant={variant}>
    <SiteHeader sourceHref={sourceHref} />
    <main id="main-content">
      <section id="top" className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero-copy">
          <h1 id="landing-title">You approve. Crank delivers.</h1>
          <p className="landing-subhead">Events from one app become actions in another, sent only after you check the exact details.</p>
          <p className="landing-alternative">100% free, open source alternative to <strong>Zapier</strong>, <strong>Make</strong> and <strong>n8n</strong></p>
          <RunActions />
          <p className="landing-license-line">Free and open source, MIT licensed.</p>
        </div>
        <HeroPlate />
      </section>
      <div className="landing-sections">
        <Section id="free" eyebrow="Free" heading="Free for every run." body="Free as in cost and free as in code, however many flows you run." />
        <Section id="runs" eyebrow="Runs" heading="Every run, in plain sight." body="Each run keeps its exact input, who approved it and what the destination answered." reverse />
        <Section id="replay" eyebrow="Replay" heading="One replay, same key." body="If the destination was down, replay once with the same body and delivery key." />
        <Section id="agents" eyebrow="Agents" heading="Agents prepare. You decide." body="Give an agent a credential to prepare flows and runs. Only an owner approves." reverse />
        <Section id="flows" eyebrow="Flows" heading="One flow, two apps." body="Name the source, point it at a destination, and activate it when you’re ready." />
        <section id="included" className="landing-included" aria-labelledby="included-heading">
          <h2 id="included-heading">Also included</h2>
          <ul>{included.map(({ label, icon }) => <li key={icon}><Plate className="landing-included-tile" recessed={false}><LineIcon name={icon} /><span>{label}</span></Plate></li>)}</ul>
        </section>
        <Section id="try" heading="Try it beside what you have." body="Bring a Webhook → HTTP Request workflow from n8n, check the dry run, and undo it while unused." />
        <section id="run" className="landing-close" aria-labelledby="close-heading"><h2 id="close-heading">You approve. Crank delivers.</h2><RunActions /></section>
      </div>
    </main>
    <SiteFooter sourceHref={sourceHref} />
  </div>
}
