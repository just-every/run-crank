import { AuthError } from '../errors.mjs';

// The accounts adapter interface: everything identity needs from an app's own
// accounts. Base's oa_ store (./oa.mjs) is one implementation; a seed with its
// own tables (HappyToHelp, Slate) implements the same methods over them.
//
//   findByEmail(email)            the person whose account holds this proven email, or null
//   findBinding({issuer,subject}) the person bound to this provider principal, or null
//   bind({issuer,subject,person,associated})
//                                 bind the principal; true when it now names this person.
//                                 Never rebinds a principal bound to someone else, binds only
//                                 proven emails or explicit associations, and revokes the
//                                 person's earlier password credentials.
//   issueSession({person,principal,method,returnTo,request})
//                                 a CompletedSession ({session,operator,cookie,returnTo}) or null
//   revokeSession(sessionId)      end one session
//   owner()                       the app's owner, or null
// Optional:
//   bindAndIssueSession(input)    atomically bind and issue with current setting/version fences
//   identityEnabled()            provider admission setting; missing means off
//   currentBoundSubject(input)   current subject for person/issuer; absent denies editor authority
//   acceptInvitation({person,principal,returnTo,request})  accept a pending invitation
//   requiredProvider(email)       the provider id an email's domain must use, or null
//
// A person is { id, email, status: 'active'|'invited'|'inactive', owner: boolean }.
const REQUIRED = ['findByEmail', 'findBinding', 'bind', 'issueSession', 'revokeSession', 'owner'];
const OPTIONAL = ['bindAndIssueSession','acceptInvitation', 'requiredProvider', 'currentBoundSubject', 'identityEnabled'];

export function accountsAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || REQUIRED.some(name => typeof adapter[name] !== 'function')
    || OPTIONAL.some(name => adapter[name] !== undefined && typeof adapter[name] !== 'function')) throw new AuthError('invalid_accounts_adapter', 503);
  return adapter;
}

export function person(value) {
  if (!value) return null;
  if (typeof value.id !== 'string' || typeof value.email !== 'string' || !['active', 'invited', 'inactive'].includes(value.status) || typeof value.owner !== 'boolean') {
    throw new AuthError('invalid_accounts_adapter', 503);
  }
  return value;
}
