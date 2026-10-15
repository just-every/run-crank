import { Plate } from './Plate'

/** The editable three-slot machine follows the approved 12ui conversion. */
export function HeroPlate() {
  return <Plate className="landing-hero-plate" recessed={false} label="Crank: an event arrives, you approve it, and it is delivered.">
    <div className="landing-hero-step">
      <div className="landing-step-heading"><span className="landing-step-number" aria-hidden="true">1</span><span>Event arrives</span><i aria-hidden="true" /></div>
      <div className="metal-slot landing-hero-screen landing-event-screen">
        <strong className="landing-ticket">ticket-1042</strong>
        <span className="status-chip" data-state="pending">pending</span>
        <p className="landing-mono landing-hero-route">Support desk → Operations inbox</p>
      </div>
    </div>
    <div className="landing-hero-step">
      <div className="landing-step-heading"><span className="landing-step-number" aria-hidden="true">2</span><span>You approve</span><i aria-hidden="true" /></div>
      <div className="metal-slot landing-hero-screen landing-approval-screen">
        <dl className="landing-event-detail landing-mono"><dt>customer:</dt><dd>Harbour Workshop</dd><dt>task:</dt><dd>Book a callback</dd></dl>
        <div className="landing-approval-key"><span className="crank-key landing-key">Approve and deliver</span></div>
      </div>
    </div>
    <div className="landing-hero-step">
      <div className="landing-step-heading"><span className="landing-step-number" aria-hidden="true">3</span><span>Delivered</span><i aria-hidden="true" /></div>
      <div className="metal-slot landing-hero-screen landing-delivered-screen">
        <span className="status-chip" data-state="succeeded">succeeded</span>
        <p className="landing-mono landing-inbox">Operations inbox</p>
        <div className="landing-delivered-record"><p className="landing-mono">Harbour Workshop · Book a callback</p></div>
      </div>
    </div>
  </Plate>
}
