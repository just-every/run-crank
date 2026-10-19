/** A named step failure. `category` routes it (EXEC-003); `message` is safe to show. */
export type FailureCategory = 'validation' | 'type_mismatch' | 'mapping' | 'provider' | 'auth' | 'network' | 'uncertain' | 'rate_limit' | 'egress' | 'not_found' | 'config' | 'business' | 'connection' | 'authority'
export class StepError extends Error {
  constructor(readonly category: FailureCategory, message: string, readonly detail: Record<string, unknown> = {}) { super(message) }
  toJSON() { return { category: this.category, message: this.message, ...this.detail } }
}
