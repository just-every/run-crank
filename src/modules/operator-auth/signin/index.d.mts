import type { OperatorAuth } from '../index.mjs';

export interface SignInPageOptions {
  /** While the first owner is unclaimed: the setup form and its instructions. */
  setup?: (request: Request) => null | false | undefined | { instructions?: string } | Promise<null | false | undefined | { instructions?: string }>;
  /** Extra same-origin links under the form (for example the local development outbox). */
  links?: (request: Request) => Array<{ href: string; label: string }> | Promise<Array<{ href: string; label: string }>>;
  defaultReturnTo?: string;
}
/** The shared server-rendered sign-in page at branding.signInPath (GET and HEAD); null for anything else. */
export function createSignInHandler<R extends string>(auth: OperatorAuth<R>, options?: SignInPageOptions): (request: Request) => Promise<Response | null>;
