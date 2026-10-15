import type { AuthConfig, AuthHooks, CompletedSession, Session, StepUpAction, StepUpConfirmed, LinkPreview, MailSender, OperatorAuth } from '../../index.mjs';
import type { NativePerson } from '../../accounts/native.mjs';
export const STEP_UP_ACTIONS: readonly StepUpAction[];
export const STEP_UP_SECONDS: number;
export interface LinkRecord { id: string; hash: string; kind: 'magic'; returnTo: string; expiresAt: number; operatorId: string; expectedVersion: number; now: number }
export interface NativeLinkPreview { kind: 'magic'; email: string; operatorId: string; version: number; expiresAt: number; returnTo: string; dev?: boolean }
export interface StepUpChallenge { id: string; hash: string; action: StepUpAction; returnTo: string; now: number; expiresAt: number }
/** Persistence is the authority boundary. Consumption + current authority check + issuance are one transaction, not separate read/write calls. */
export interface NativeProofPersistence<R extends string = string> {
  limits(keys: string[], now: number, windowMs: number): Promise<number[]>;
  token(record: LinkRecord): Promise<boolean>;
  preview(digest: string, now: number): Promise<NativeLinkPreview | null>;
  consumeLink(input: {request: Request; digest: string; person: NativePerson<R>; now: number; returnTo: string}): Promise<CompletedSession<R> | null>;
  revokeLink(id: string, now: number): Promise<unknown>;
  stepUpPreview(digest: string, now: number): Promise<{expiresAt: number} | null>;
  stepUpChallenge(record: StepUpChallenge, actor: Session<R>): Promise<boolean>;
  consumeStepUp(digest: string, actor: Session<R>, now: number): Promise<{action: StepUpAction; returnTo: string} | null>;
  revokeStepUp(id: string, now: number): Promise<unknown>;
  /** Recheck asking session, current person version/status and persisted local proof; never infer freshness from session kind. */
  steppedUp(actor: Session<R>, since: number, now: number): Promise<boolean>;
}
export interface EmailLinkPersistence<R extends string = string> extends Omit<NativeProofPersistence<R>, 'preview' | 'consumeLink'> {
  /** Required when supplying hooks.afterConfirm directly; durably revoke the issued session before reporting refusal. */
  revokeSession?(id: string): Promise<unknown>;
  authenticate(request: Request): Promise<Session<R> | null>;
  requiredProvider(email: string): Promise<string | null>;
  byEmail(email: string): Promise<NativePerson<R> | null>;
  authorizedLink(request: Request, digest: string): Promise<{link: NativeLinkPreview; person?: NativePerson<R>} | null>;
  consumeLink(input: {request: Request; digest: string; approval: {link: NativeLinkPreview; person?: NativePerson<R>}; now: number}): Promise<CompletedSession<R> | null>;
}
/** A direct veto hook requires revocation authority. A composed callback owns its hooks and revocation; never supply the same hook through both paths. */
export type EmailLinkCompletion<R extends string> = {
  persistence: EmailLinkPersistence<R> & { revokeSession(id: string): Promise<unknown> };
  hooks?: AuthHooks<R>;
  afterConfirm?: never;
} | {
  persistence: EmailLinkPersistence<R>;
  hooks?: Omit<AuthHooks<R>, 'afterConfirm'> & { afterConfirm?: never };
  afterConfirm?: (request: Request, completed: CompletedSession<R>, method: 'email') => Promise<CompletedSession<R>>;
};
/** Standalone composition normalizes the same AuthConfig used by createOperatorAuth. */
export function createEmailLinkLifecycle<R extends string>(options: {
  config: AuthConfig;
  clock?: () => number; mailSender?: MailSender; clientIp: (request: Request) => string | Promise<string>;
  hash: (purpose: string, token: string) => Promise<string>;
} & EmailLinkCompletion<R>): Pick<OperatorAuth<R>, 'requestMagicLink' | 'previewLink' | 'confirmLink' | 'requestStepUp' | 'requireStepUp'> & {
  requireFreshProof(actor: Session<R>): Promise<void>;
};
