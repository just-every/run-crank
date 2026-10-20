const codes = new Map([
  [400, 'invalid_request'], [405, 'invalid_request'], [406, 'invalid_request'],
  [413, 'invalid_request'], [415, 'invalid_request'], [401, 'unauthenticated'],
  [403, 'forbidden'], [404, 'not_found'], [409, 'conflict'],
  [422, 'invalid_operation'], [502, 'unavailable'], [503, 'unavailable'],
]);

/** Stable public error for HTTP failures, transport failures and bad responses. */
export class CrankApiError extends Error {
  constructor(message, { code, status = 0, details = null } = {}) {
    super(message);
    this.name = 'CrankApiError';
    this.code = code ?? 'operation_failed';
    this.status = status;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, message: this.message, code: this.code, status: this.status, details: this.details };
  }
}

export function httpError(status, payload) {
  const record = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  return new CrankApiError(typeof record?.error === 'string' ? record.error : `Crank request failed (HTTP ${status})`, {
    code: typeof record?.code === 'string' ? record.code : codes.get(status) ?? 'operation_failed',
    status,
    details: record,
  });
}
