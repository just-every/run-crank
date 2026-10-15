const messages = {
  ai_disabled: 'AI is off for this feature.',
  ai_misconfigured: 'Configure exactly one AI transport for this feature.',
  ai_unavailable: 'The AI provider is unavailable.',
  ai_target_mismatch: 'The served target differs from the pinned model requested.',
  ai_invalid_response: 'The AI provider returned an invalid response.',
  ai_invalid_request: 'The AI request is invalid.',
  dev_fake_cannot_answer: 'The dev double cannot answer schema-typed outputs or forced tool calls. Use live dev with a capped Models dev app.',
  dev_access_denied: 'Not found',
  dev_outbox_unavailable: 'The local AI outbox is unavailable.',
};

/** Fixed messages only: credentials and upstream exception bodies never escape. */
export class AiError extends Error {
  constructor(code, status = 502) {
    super(messages[code] ?? 'The AI request was refused.');
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

export const serviceErrorCodes = new Set([
  'ai_unavailable', 'ai_misconfigured', 'no_eligible_target', 'field_not_allowed',
  'budget_exhausted', 'upstream_limited', 'upstream_unavailable', 'upstream_auth',
  'upstream_policy_unmet', 'upstream_uncertain', 'upstream_error',
  'response_too_large', 'dev_fake_cannot_answer',
]);
