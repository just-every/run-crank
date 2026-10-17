import { AppTile, Check, Dot, Painting } from '../parts'

/** Desk page 4: the brass gears close up, with the run's last step and today's count as real cards. */
export function Interlude() {
  return <section className="interlude" aria-label="Brass gears turning beside the lake: the invoice was created in QuickBooks at 9:15 AM; 1,284 runs today, 0 failed.">
    <div className="interlude-stage">
    <Painting className="interlude-art" name="interlude" widths={[768, 1152, 1536]} sizes="(max-width: 760px) 200vw, (max-width: 1180px) 150vw, 100vw" />
    <div className="interlude-cards" aria-hidden="true">
      <div className="card interlude-invoice">
        <p className="interlude-invoice-head"><AppTile app="quickbooks" /><strong>Create invoice in QuickBooks</strong></p>
        <p className="interlude-invoice-foot"><Check /><span>Completed</span><time>9:15 AM</time></p>
      </div>
      <div className="card interlude-count"><p><Dot />Runs today</p><strong>1,284 · 0 failed</strong></div>
    </div>
    </div>
  </section>
}
