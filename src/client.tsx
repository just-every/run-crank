import { StrictMode, startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start/client'
import { createRecoverableErrorHandler } from './base/hydration/report'

// Start's default client entry calls hydrateRoot with no options. This one keeps
// it and adds Base's hydration report: a mismatch warns in dev and is counted
// quietly in production (src/base/hydration/README.md). A seed with an error
// tracker passes a reporter to createRecoverableErrorHandler.
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
    { onRecoverableError: createRecoverableErrorHandler() },
  )
})
