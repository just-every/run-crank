/** A seed's idempotent demo data, run once after the owner exists. */
export type SeedDemo<Env> = (env: Env, context: { ownerEmail: string; now: Date }) => Promise<void>;
export interface DemoOptions<Env> {
  seed?: SeedDemo<Env>;
  /** The D1 binding for the demo's seeding marker (default DB). */
  binding?: string;
  /** The active owner's email, or null before one exists (default: Base operator-auth's owner). */
  owner?: (env: Env) => Promise<string | null>;
}
/** Demo mode for a seed's Worker; returns the worker unchanged unless RER_DEMO=1. Import it first. */
export function withDemo<Env, Handler extends { fetch?: (request: never, env: Env, execution: never) => unknown }>(worker: Handler, options?: DemoOptions<Env>): Handler;
/** Real public checks that use a write-shaped HTTP method (such as POST probes). */
export function fetchDemoRead(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
/** Mock a non-HTTP send only in a demo, otherwise run the real send. */
export function demoEffect<Result>(send: () => Result | Promise<Result>, success: Result | (() => Result | Promise<Result>)): Promise<Result>;
