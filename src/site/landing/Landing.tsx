import { SiteHeader } from '../shell/SiteHeader'
import { Hero } from './Hero'
import { AllDay } from './sections/AllDay'
import { BooksMatch } from './sections/BooksMatch'
import { Closing } from './sections/Closing'
import { MoveIn } from './sections/MoveIn'
import { OneRun } from './sections/OneRun'
import { Outage } from './sections/Outage'
import { Overnight } from './sections/Overnight'
import '../styles/site.css'
import '../styles/landing.css'
import '../styles/cards.css'
import '../styles/sections/move-in.css'
import '../styles/sections/one-run.css'
import '../styles/sections/all-day.css'
import '../styles/sections/outage.css'
import '../styles/sections/overnight.css'
import '../styles/sections/books-match.css'

/**
 * run-crank.com's homepage on the owner-approved structure s1 (17 Oct 2026): one buyer's week and month with Crank,
 * in the order they meet it. The hero; moving in on Monday; one run traced on Tuesday morning; the whole day's runs;
 * Shopify's outage and recovery; the overnight API change on the night plate; the month-end close and the limits;
 * the closing with the footer. Painted art appears only in the hero, the night plate and the closing.
 */
export function Landing() {
  return <>
    <SiteHeader overArt />
    <main id="main">
      <Hero />
      <MoveIn />
      <OneRun />
      <AllDay />
      <Outage />
      <Overnight />
      <BooksMatch />
      <Closing />
    </main>
  </>
}
