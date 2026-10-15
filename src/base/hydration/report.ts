// React calls onRecoverableError when it recovers from a hydration mismatch by
// client-rendering the nearest boundary. Its default reports an uncaught error
// (in production "Minified React error #418"), which fills consoles and error
// trackers for an event the page already recovered from. This handler:
//  - in dev, warns once per recovered boundary with React's error and the
//    component stack, so the mismatch is visible and findable;
//  - in production, stays silent and counts recoveries for the page view in
//    window.__rerHydration ({ path, count, kinds, stacks }; `count` is the
//    contract, the rest is diagnostic);
//  - calls `report` once on pagehide with that summary, only if a mismatch
//    happened (a seed with an error tracker passes one);
//  - leaves every other recoverable error to React's default (reportError).
export type HydrationSummary = { path: string, count: number, kinds: string[], stacks: string[] }
type ErrorInfo = { componentStack?: string }
declare global { interface Window { __rerHydration?: HydrationSummary } }

// Vite replaces import.meta.env.DEV at build time. Typed here so this file needs no
// package types (Base's default-seed compiles it from outside its own folder).
const dev = () => Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV)
const mismatch = (error: unknown) => error instanceof Error && /Hydration failed|#418|error #42[23]/.test(error.message)
const stackHead = (stack = '') => stack.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 4).join(' < ')

export function createRecoverableErrorHandler(report?: (summary: HydrationSummary) => void) {
  return (error: unknown, info: ErrorInfo) => {
    if (!mismatch(error)) { globalThis.reportError?.(error); return }
    const summary = (window.__rerHydration ??= { path: location.pathname, count: 0, kinds: [], stacks: [] })
    if (summary.count === 0 && report) addEventListener('pagehide', () => report(summary), { once: true })
    summary.count++
    const kind = /server rendered (text|HTML)|args\[\]=(text|HTML)/.exec((error as Error).message)
    summary.kinds.push(kind ? (kind[1] ?? kind[2]) : 'other')
    summary.stacks.push(stackHead(info.componentStack))
    if (dev()) console.warn('[rer] hydration mismatch: React client-rendered the nearest hydration unit (src/base/hydration/README.md).', error, info.componentStack)
  }
}
