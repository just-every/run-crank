export { createMailSender } from './src/sender.mjs';

export { MailValidationError, DevelopmentOutboxError } from './src/core/errors.mjs';
export { serializeSendGridMessage } from './src/adapters/sendgrid/index.mjs';
export { verifyWebhook, MAX_WEBHOOK_BYTES, createDeliveryEventIntake, createD1EventStore } from './src/events/index.mjs';
export { normalizeInbound, createResendAttachmentFetcher } from './src/inbound/index.mjs';
export { mailDoctor } from './src/doctor/index.mjs';
export { applyUnsubscribeHeaders } from './src/unsubscribe/index.mjs';
