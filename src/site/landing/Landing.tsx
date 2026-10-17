import { SiteHeader } from '../shell/SiteHeader'
import { Hero } from './Hero'
import { Builder, ReliableRuns } from './sections/Building'
import { MoveIn, SelfRepair } from './sections/Changing'
import { Closing } from './sections/Closing'
import { Connectors, Triggers } from './sections/Connecting'
import { AiSteps, Approvals } from './sections/Deciding'
import { Details } from './sections/Details'
import { Interlude } from './sections/Interlude'
import { Ownership } from './sections/Ownership'
import '../styles/site.css'
import '../styles/landing.css'
import '../styles/cards.css'

/**
 * run-crank.com's homepage, built from the design desk's approved page (17 Oct 2026, hero C, mark 6) in its order:
 * hero; connectors and triggers; builder and reliable runs; the interlude; approvals and AI steps;
 * self-repair and moving in; ownership; the quiet details; the closing with the footer.
 * Painted art appears only in the hero, the interlude and the closing; every other drawing is HTML and CSS.
 */
export function Landing() {
  return <>
    <SiteHeader overArt />
    <main id="main">
      <Hero />
      <div className="pairs">
        <Connectors /><Triggers />
        <Builder /><ReliableRuns />
      </div>
      <Interlude />
      <div className="pairs">
        <Approvals /><AiSteps />
        <SelfRepair /><MoveIn />
        <Ownership />
        <Details />
      </div>
      <Closing />
    </main>
  </>
}
