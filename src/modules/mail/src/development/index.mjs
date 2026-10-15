import { MailValidationError, fail } from '../core/errors.mjs';
import { validateConfig, validateMessage } from '../core/validation.mjs';
import { sendResult } from '../core/transport.mjs';

// Retained for reading and erasing messages saved by older local installations.
export { createD1DevelopmentOutbox } from './outbox.mjs';
export { DevelopmentOutboxError } from '../core/errors.mjs';

function validate(operation, errorCode) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof MailValidationError) throw error;
    fail(errorCode);
  }
}

/** Explicit development delivery validates the message and silently suppresses it. */
export async function sendDevelopment(config, message, dependencies = {}) {
  validate(() => validateConfig(config, dependencies), 'invalid_config');
  if (validate(() => config.provider, 'invalid_config') !== 'development') fail('development_provider_required');
  validate(() => validateMessage(message, 'development'), 'invalid_message');
  if (validate(() => message.unsubscribe, 'invalid_message') !== undefined) fail('unsubscribe_not_assembled');
  return sendResult('development', 'development', null);
}
