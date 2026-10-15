import type { AiTransport, AiRequest } from '../index.mjs';
export const DEV_AI_MARKER: string;
export function createFakeTransport(options?: { script?: AiTransport['request']; capture?: (record: { feature: string; operation: string; request?: AiRequest; response?: unknown; usage?: unknown; error?: { code: string; status: number } }) => Promise<void> }): AiTransport;
