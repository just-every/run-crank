import type { AuthConfig, Role } from '../index.mjs';
export const DEV_LAYER_MARKER: string;
export interface DevPersona { as: string; role: Role; displayName?: string }
export interface DevIdentityOptions<Env> {
  /** The seed's own binding normalization (for example its RER_DEV_ORIGIN override). */
  bindings?: (env: Env) => Env;
  /** The seed's own operator-auth configuration. */
  config: (env: Env) => AuthConfig;
  /** The seed's devPersonas(): real operators at `<as>@dev.localhost`, created only in local dev. */
  personas?: () => DevPersona[];
}
export function managedInstallation(env: Record<string, unknown>): boolean;
/** Local-only Worker wrapper. Never import from a deployed entry. */
export function withDevIdentity<Env, Handler extends { fetch?: (request: never, env: Env, execution: never) => unknown }>(worker: Handler, options: DevIdentityOptions<Env>): Handler;
