import { Actions } from '../../shell/Actions'
import { SiteFooter } from '../../shell/SiteFooter'
import { Painting } from '../parts'

/** Desk page 9: the sailboat on the lake, the last call to run Crank, then the footer. */
export function Closing() {
  return <>
    <section className="closing" aria-labelledby="closing-title">
      <div className="closing-copy">
        <h2 id="closing-title">Your time, back.</h2>
        <p className="closing-sub">Open source workflow automation for every team.</p>
        <Actions demo={false} />
        <p className="closing-licence">Free and open source, MIT licensed.</p>
      </div>
      <div className="closing-stage">
        <Painting className="closing-art" name="closing" widths={[768, 1152, 1536]} sizes="100vw" />
        <p className="boat-sign">All 58 workflows ran <span className="boat-check" aria-hidden="true">✓</span></p>
      </div>
    </section>
    <SiteFooter />
  </>
}
