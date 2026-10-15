import { Suspense, type ReactNode } from 'react'

// One hydration unit (README.md in this folder). React renders it inline on the
// server as <!--$-->…<!--/$--> (it never suspends, and Start streams with an
// infinite progressiveChunkSize, so no fallback is sent) and hydrates it as its
// own boundary. When something in the browser changed its DOM before hydration
// (an extension linking an address, a translator, Cloudflare's email
// obfuscation), React client-renders only this unit instead of everything under
// the route's single boundary. No wrapper element: layout, CSS selectors and
// landmarks are unchanged.
export function HydrationUnit({ children }: Readonly<{ children: ReactNode }>) {
  return <Suspense fallback={null}>{children}</Suspense>
}
