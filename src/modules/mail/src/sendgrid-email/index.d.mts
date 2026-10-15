export interface SendGridMessage {
  readonly from: string
  readonly to: readonly string[]
  readonly subject: string
  readonly text: string
  readonly html?: string | null
  readonly replyTo?: string
  readonly headers?: Readonly<Record<string, string>>
  /** `content` is a base64 string. `type` defaults to application/octet-stream. */
  readonly attachments?: readonly { readonly content: string; readonly filename: string; readonly type?: string }[]
  readonly asmGroupId?: number
  readonly subscriptionTracking?: boolean
  readonly customArgs?: Readonly<Record<string, string>>
  /** Durable local command ID for correlation; SendGrid does not deduplicate it. */
  readonly deliveryId: string
}

export class SendGridSendError extends Error {
  readonly outcome: 'rejected' | 'rate_limited' | 'ambiguous'
  readonly status: number | undefined
  constructor(outcome: 'rejected' | 'rate_limited' | 'ambiguous', message: string, status?: number)
}

/** Validated wire envelope, also usable as a durable claim fingerprint. */
export function serializeSendGridMessage(message: SendGridMessage): string

/** One attempt only. Acceptance and a provider receipt are distinct evidence. */
export function sendSendGrid(input: {
  readonly apiKey: string
  readonly message: SendGridMessage
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMilliseconds?: number
}): Promise<{ provider: 'sendgrid'; providerMessageId: string | null; state: 'accepted' }>
