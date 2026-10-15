export class AuthError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}
export function deny(code = 'forbidden', status = 403) { throw new AuthError(code, status); }
