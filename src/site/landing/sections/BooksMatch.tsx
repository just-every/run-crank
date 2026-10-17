import { links } from '../../shell/links'
import { AppTile, Check, Icon, SectionHead } from '../parts'
import { close } from '../week'

const Side = ({ app, name, count }: { app: 'stripe' | 'quickbooks'; name: string; count: string }) => <div className="side">
  <AppTile app={app} /><p><strong>{name}</strong><span>{close.payments} {count}</span></p><span className="side-total">{close.total}</span>
</div>

/** Friday, October 30: Stripe and QuickBooks agree for the month, then the one note on what Crank leaves out. */
export function BooksMatch() {
  return <section id="books-match" className="sec books-match" aria-labelledby="books-match-title">
    <div className="site-wrap books-row">
      <div className="card glow ledger-card" role="img" aria-label={`${close.month} close, Stripe and QuickBooks: ${close.payments} payments and ${close.payments} invoices, both ${close.total}, matched. Fixed this month: ${close.fixes.map(f => `${f.who}, ${f.amount}, ${f.cause}: ${f.fix} ${f.ref}`).join('; ')}.`}>
        <div aria-hidden="true">
          <h3 className="ledger-title"><span>{close.month} close</span><span className="sep">·</span><span>Stripe <span className="both">↔</span> QuickBooks</span></h3>
          <div className="sides"><Side app="stripe" name="Stripe" count="payments" /><span className="matched"><span className="chip chip-done">Matched</span></span><Side app="quickbooks" name="QuickBooks" count="invoices" /></div>
          <p className="kicker ledger-kicker">Fixed this month</p>
          <ul className="fixes">{close.fixes.map(f => <li key={f.ref}>
            <span className="fix-who">{f.who}<span className="sep">·</span>{f.amount}</span>
            <span className="fix-cause"><span className="sep">·</span>{f.cause}</span>{' '}
            <span className="fix-how"><span className="fix-arrow">→ </span>{f.fix} <code>{f.ref}</code></span>
            <Check />
          </li>)}</ul>
        </div>
      </div>
      <SectionHead id="books-match" eyebrow="Friday, October 30" title={<>The books<br /> match.</>}>Crank checks every Stripe payment against its QuickBooks invoice, and fixes what is missing before you close the month.</SectionHead>
    </div>
    <div className="site-wrap">
      <aside className="card limits" aria-label="What it doesn't do">
        <Icon name="moon" className="limits-icon" />
        <p><strong>What it doesn’t do.</strong> <span>No desktop or screen-scraping robots. Apps outside the library connect over HTTP or a code step.</span></p>
        <a href={links.limits}>Read the limits<span aria-hidden="true"> →</span></a>
      </aside>
    </div>
  </section>
}
