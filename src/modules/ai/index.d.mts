export type AiErrorCode = 'ai_disabled' | 'ai_misconfigured' | 'ai_unavailable' | 'ai_target_mismatch' | 'ai_invalid_request' | 'ai_invalid_response' | 'dev_fake_cannot_answer' | 'dev_access_denied' | 'dev_outbox_unavailable' | 'no_eligible_target' | 'field_not_allowed' | 'budget_exhausted' | 'upstream_limited' | 'upstream_unavailable' | 'upstream_auth' | 'upstream_policy_unmet' | 'upstream_uncertain' | 'upstream_error' | 'response_too_large';
export class AiError extends Error { readonly code: AiErrorCode; readonly status: number; constructor(code: AiErrorCode, status?: number); }
export interface AiConfig { enabled?: boolean; model?: string; direct?: { baseUrl?: string; apiKey?: string }; models?: { baseUrl?: string; apiKey?: string }; features?: Record<string, 'direct' | 'models'>; }
export interface AiOptions { feature?: string; signal?: AbortSignal; subject?: string; }
export interface AiRequest { model?: string; stream?: boolean; [field: string]: unknown; }
export interface AiClient { chat(body: AiRequest, options?: AiOptions): Promise<Response>; responses(body: AiRequest, options?: AiOptions): Promise<Response>; embeddings(body: AiRequest, options?: AiOptions): Promise<Response>; receipt(id: string, options?: AiOptions): Promise<Response>; }
export interface AiTransport { request(input: { operation: 'chat' | 'responses' | 'embeddings' | 'receipt'; body?: AiRequest; feature: string; signal?: AbortSignal; selected: { name: string; baseUrl: string; apiKey: string } }): Promise<Response>; }
export function createAiClient(config?: AiConfig, dependencies?: { fetch?: typeof fetch; transport?: AiTransport }): AiClient;
export function aiConfig(env?: Record<string, unknown>, features?: AiConfig['features']): AiConfig;
export function aiDiagnostics(config?: AiConfig): Array<{ feature: string; code: AiErrorCode; message: string }>;
