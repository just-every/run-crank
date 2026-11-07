export class ToolRefusal extends Error {
  code: string
  details: Record<string, unknown>
  constructor(code: string, message = code, details: Record<string, unknown> = {}) {
    super(message); this.name = 'ToolRefusal'; this.code = code; this.details = details
  }
}
export const json = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } })
export const error = (code: string, status = 400, fields: Record<string, unknown> = {}) => json({ code, ...fields }, status)
