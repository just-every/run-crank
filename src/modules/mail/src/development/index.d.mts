export interface DevelopmentMessage {
  deliveryId: string;
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; contentType: string; content: Uint8Array; disposition?: 'attachment' | 'inline'; contentId?: string }>;
  customArgs?: Record<string, string>;
  asmGroupId?: number;
  subscriptionTracking?: boolean;
}
export interface DevelopmentCapture { id: string; createdAt: number; message: DevelopmentMessage }
export type DevelopmentOutboxListMessage = Omit<DevelopmentMessage, 'attachments'>;
export interface DevelopmentOutboxListCapture { id: string; createdAt: number; message: DevelopmentOutboxListMessage }
export interface DevelopmentOutbox {
  put(message: DevelopmentMessage): Promise<void>;
  list(): Promise<DevelopmentOutboxListCapture[]>;
  get(id: string): Promise<DevelopmentCapture | null>;
}
export interface DevelopmentD1Statement { bind(...values: unknown[]): DevelopmentD1Statement }
export interface DevelopmentD1Database {
  prepare(sql: string): DevelopmentD1Statement;
  batch(statements: DevelopmentD1Statement[]): Promise<Array<{ success: boolean; results: unknown[] }>>;
}
/** Storage failure: the message is valid, so a queue consumer retries instead of dropping it. Invalid input throws `MailValidationError`, which is permanent. */
export class DevelopmentOutboxError extends Error {
  readonly name: 'DevelopmentOutboxError';
  readonly code: 'development_outbox_failed';
  readonly retryable: true;
}
export function createD1DevelopmentOutbox(options: { db: DevelopmentD1Database; maxMessages?: number; maxAgeMs?: number; clock?: () => number }): DevelopmentOutbox;
export function sendDevelopment(config: { provider: 'development'; mode: 'development' }, message: DevelopmentMessage,
  dependencies?: { clock?: () => number }): Promise<{ provider: 'development'; status: 'development'; providerMessageId: null }>;
