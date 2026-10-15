import type { AiClient, AiConfig, AiTransport } from '../index.mjs';
export const DEV_AI_MARKER: string;
export interface AiOutbox { put(record: object): Promise<void>; list(): Promise<object[]>; }
export function createAiOutbox(options: { db: D1Database; clock?: () => number; maxRequests?: number; maxAgeMs?: number }): AiOutbox;
export function createDevAiClient(config: AiConfig, dependencies: { request: Request; key?: string; origin: string; local: boolean; outbox: AiOutbox; live?: { baseUrl: string; apiKey: string }; fetch?: typeof fetch; script?: AiTransport['request'] }): AiClient;
export function withDevAi<Env, Worker extends { fetch?: (request: never, env: Env, execution: never) => unknown }>(worker: Worker, options?: { bindings?: (env: Env) => Env }): Worker;
