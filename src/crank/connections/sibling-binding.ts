import { checkEgress } from '../engine/egress'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { requireValue } from '../model'

/** Immutable destination selected by the native owner, independently of mapped data. */
export interface SiblingBinding { origin: string; conversation_id: string }
export function siblingBinding(value: unknown): SiblingBinding {
  requireValue(isObject(value), 'Nook needs a binding with origin and conversation_id')
  requireValue(Object.keys(value).every(key => ['origin', 'conversation_id'].includes(key)), 'Unknown Nook binding field')
  requireValue(typeof value.origin === 'string', 'Nook needs its installation origin')
  const url = checkEgress(value.origin)
  requireValue(url.protocol === 'https:' && url.origin === value.origin, 'Use an exact HTTPS installation origin without a path or query')
  requireValue(typeof value.conversation_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value.conversation_id), 'Choose one Nook conversation identifier')
  return { origin: url.origin, conversation_id: value.conversation_id }
}

/** Also applied to generic HTTP and connection-test doors using this credential. */
export function assertSiblingDestination(binding: SiblingBinding, url: URL) {
  if (url.origin !== binding.origin || url.pathname !== `/api/conversations/${binding.conversation_id}/messages` || url.search || url.hash)
    throw new StepError('egress', 'Nook credentials are bound to one exact installation and conversation')
}
