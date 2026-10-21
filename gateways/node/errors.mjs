export const MAX_OUTPUT_BYTES = 64 * 1024;
export class GatewayError extends Error {
  constructor(category, message) { super(message); this.category = category; }
}
export const fail = (category, message) => { throw new GatewayError(category, message); };
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
