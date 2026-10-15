import { AiError } from '../errors.mjs';

export const DEV_AI_MARKER = 'rer-ai-dev:local-only-never-deploy';
const encoder = new TextEncoder();
async function hash(input) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(input)));
  return [...new Uint8Array(bytes)];
}
const hex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join('');
const headers = { 'cache-control': 'no-store', 'x-rer-ai-dev': DEV_AI_MARKER };
function sse(events, signal) {
  return new Response(new ReadableStream({
    pull(controller) {
      if (signal?.aborted) { controller.error(new AiError('upstream_uncertain', 504)); return; }
      const event = events.shift();
      if (event === undefined) { controller.close(); return; }
      controller.enqueue(encoder.encode(event));
    },
  }), { headers: { ...headers, 'content-type': 'text/event-stream' } });
}
const data = value => `data: ${JSON.stringify(value)}\n\n`;
const event = (type, value) => `event: ${type}\n${data({ type, ...value })}`;

/** Explicit provider-edge double. Scripted mode never invents an answer. */
export function createFakeTransport({ script, capture = async () => {} } = {}) {
  return {
    async request({ operation, body, feature, signal }) {
      if (signal?.aborted) throw new AiError('upstream_uncertain', 504);
      try {
        if (script) {
          const response = await script({ operation, body, feature, signal });
          if (!response.headers.get('content-type')?.includes('text/event-stream')) await capture({ feature, operation, request: body, response: await response.clone().json() });
          return response;
        }
        const format = body.response_format?.type ?? body.text?.format?.type;
        const forcedTool = body.tool_choice !== undefined && !['auto', 'none'].includes(body.tool_choice);
        if (format === 'json_schema' || forcedTool) throw new AiError('dev_fake_cannot_answer', 422);
        if (format !== undefined && !['text', 'json_object'].includes(format)) throw new AiError('ai_invalid_request', 400);
        const { stream: _stream, stream_options: _streamOptions, ...content } = body;
        const digest = await hash(content), id = 'dev_' + hex(digest).slice(0, 16);
        const text = format === 'json_object' ? '{}' : `[dev] ${feature} ${hex(digest).slice(0, 8)}`;
        const tokens = Math.ceil(encoder.encode(JSON.stringify(body)).length / 4);
        let answer, usage, events;
        if (operation === 'embeddings') {
          const inputs = typeof body.input === 'string' || (Array.isArray(body.input) && body.input.every(x => typeof x === 'number')) ? [body.input] : body.input;
          const dimensions = body.dimensions ?? 8;
          if (!Array.isArray(inputs) || !inputs.length || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) throw new AiError('ai_invalid_request', 400);
          const vectors = await Promise.all(inputs.map(async (input, index) => {
            const bytes = await hash(input);
            const embedding = Array.from({ length: dimensions }, (_, i) => (bytes[i % bytes.length] - 127.5) / 127.5);
            if (body.encoding_format !== undefined && !['float', 'base64'].includes(body.encoding_format)) throw new AiError('ai_invalid_request', 400);
            if (body.encoding_format === 'base64') {
              const binary = new Uint8Array(dimensions * 4), view = new DataView(binary.buffer);
              embedding.forEach((value, i) => view.setFloat32(i * 4, value, true));
              return { object: 'embedding', index, embedding: btoa(String.fromCharCode(...binary)) };
            }
            return { object: 'embedding', index, embedding };
          }));
          usage = { prompt_tokens: tokens, total_tokens: tokens };
          answer = { object: 'list', model: body.model, data: vectors, usage };
        } else if (operation === 'chat') {
          usage = { prompt_tokens: tokens, completion_tokens: Math.ceil(text.length / 4), total_tokens: tokens + Math.ceil(text.length / 4) };
          answer = { id, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage };
          const split = Math.ceil(text.length / 2);
          events = [text.slice(0, split), text.slice(split)].map(content => data({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] }));
          events.push(data({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }), 'data: [DONE]\n\n');
        } else if (operation === 'responses') {
          usage = { input_tokens: tokens, output_tokens: Math.ceil(text.length / 4), total_tokens: tokens + Math.ceil(text.length / 4) };
          answer = { id, object: 'response', status: 'completed', model: body.model, output: [{ id: id + '_message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage };
          const split = Math.ceil(text.length / 2);
          events = [event('response.created', { response: { ...answer, status: 'in_progress', output: [], usage: null } }), ...[text.slice(0, split), text.slice(split)].map(delta => event('response.output_text.delta', { item_id: id + '_message', output_index: 0, content_index: 0, delta })), event('response.completed', { response: answer })];
        } else throw new AiError('ai_invalid_request', 400);
        await capture({ feature, operation, request: body, response: answer, usage });
        return body.stream && events ? sse(events, signal) : Response.json(answer, { headers });
      } catch (error) {
        const safe = error instanceof AiError ? error : new AiError('ai_unavailable');
        await capture({ feature, operation, request: body, error: { code: safe.code, status: safe.status } });
        throw safe;
      }
    },
  };
}
