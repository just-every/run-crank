/** Input values never appear in validation diagnostics. */
export class MailValidationError extends Error {
  constructor(code = 'invalid_mail_input') {
    super('Mail input is invalid; check the error code and module contract.');
    this.name = 'MailValidationError';
    this.code = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'invalid_mail_input';
  }
}
export function fail(code) { throw new MailValidationError(code); }
/** The development outbox could not store the message. The message is fine: send it again. */
export class DevelopmentOutboxError extends Error {
  constructor() {
    super('Development outbox storage failed; the same message may succeed when sent again.');
    this.name = 'DevelopmentOutboxError';
    this.code = 'development_outbox_failed';
    this.retryable = true;
  }
}
