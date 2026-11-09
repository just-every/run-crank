# Failure analysis

## Tooltip timing

The reported inbound-email line contains several chained assertions. Main already moves the pointer to (0,0) and blurs before the first hidden check. It then hovers, sleeps 150 ms in Node, and asserts hidden while the production CSS delay lasts 300 ms. Hosted scheduling can resume Node after that window closes: the actual tooltip correctly becomes visible, but toBeHidden can never recover while the pointer remains on the control.

The shared browser helper clears pointer and focus and checks hidden first. The initial mouseenter listener approach passed six repetitions but failed the seventh because transitions can finish before that event handler captures them. The corrected helper freezes Chromium’s CSS animation clock before hover, then seeks the actual transitions to animation time 150 ms. The hidden assertion observes that stable timeline point; finally restores the browser animation clock, then expects actual hover visibility. Existing immediate keyboard-focus checks remain. This preserves behavior and does not add retries, skips, longer fixed timeouts, fake styles or a source change. A removed-delay mutation is rejected.

The sweep updates inbound email, AI, digest, run notices, Gmail, Calendar, HubSpot, Teams, Typeform, native editor and sibling row-control delay assertions. Other positive-only tooltip checks already clear focus through a heading click before hover. Decision-browser Escape assertions deliberately retain hover/focus to prove dismissal; they stay unchanged.

## Operational disclosure

The API returns the table descriptor immediately, without record values. It includes an opaque table ID. Searching the entire serialized object for the decimal digits 201 therefore sometimes matches the UUID, even though no table record is disclosed. Waiting would preserve the same UUID and could never repair this failure. The assertion now verifies table identity separately, excludes only that allowed identity field, and checks every remaining serialized field for the same record-value leakage as before. Empty external recipients, destination readback and complete custody/erasure assertions remain.

## Cloud setup

The required rer setup installed dependencies and built the app, then its temporary local listener failed readiness because the observed ports differed from its expected internal port. The emitted Worker browser journey passed independently. The first run-notices attempt lacked node_modules/.bin in PATH; after correction, its native rer dev launch refused to share the checkout with an active browser harness. Native rer dev checks are deferred until those harnesses finish; no unrelated process is stopped.

Re-running setup with exact Node 22.20.0 on PATH succeeded. The native run-notices journey then passed both widths on 651caafb9926ce0de8163cc836aba4dc4320cda2. Its remaining owned descendants were stopped by recorded PID after PASS. The final ten-run sequence and consumer sweep start fresh on this corrected commit.
