import { parseApiJson } from './numeric-lexemes.ts';
import type { ApiSourceInput, ApiTransport, SourceBundle } from '../types.ts';
import { consumeBytes, discardBody, responseBytes, utf8Decoder } from './bytes.ts';
import { boundedInteger, requestHeaders, retryDelay, sleep, sourceUrl } from './api-policy.ts';
import { abortable, checkAbort, fail, ReaderError } from './errors.ts';
import { limitsFor, RecordCollector, readerPaginationPolicy } from './records.ts';

/** Fetches and consumes one bounded page at a time. Authentication stays ephemeral; exact response bytes are retained. */
export async function readApiSource(input: ApiSourceInput, transport: ApiTransport): Promise<SourceBundle> {
  const policy = readerPaginationPolicy(input.paginationCursorPolicy);
  checkAbort(input.signal);
  const limits = limitsFor(input.limits);
  const maxRequests = boundedInteger(input.maxRequests, 1000);
  const maxRetries = boundedInteger(input.maxRetries, 3, true);
  const maxRetryAfterMs = boundedInteger(input.maxRetryAfterMs, 30_000, true);
  const { headers, secrets } = requestHeaders(input.headers, input.token);
  const collector = new RecordCollector(input.namespace, limits, secrets, policy);
  if (typeof input.parsePage !== 'function' || typeof transport !== 'function') fail('INVALID_API_PARSER_OR_TRANSPORT');
  if (input.preserveNumberLexeme !== undefined && typeof input.preserveNumberLexeme !== 'function') fail('INVALID_API_NUMBER_POLICY');
  const origin = sourceUrl(input.url, undefined, secrets, policy);
  let url = origin, requests = 0, page = 1, retries = 0;
  const visited = new Set<string>();
  const budget = { used: 0, max: limits.maxBytes };
  while (true) {
    checkAbort(input.signal);
    if (requests >= maxRequests) fail('SOURCE_REQUEST_LIMIT');
    if (!retries) {
      if (visited.has(url.href)) fail('SOURCE_PAGINATION_CYCLE');
      visited.add(url.href);
    }
    const location = { artifact: `api-page-${page}`, page };
    let response: Response;
    try {
      // A transport must honor manual redirects. No ambient cookies are permitted.
      const request = new Request(url, { headers, signal: input.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
      requests++;
      const pending = Promise.resolve(transport(request));
      void pending.then(value => { if (input.signal?.aborted && value instanceof Response) discardBody(value); }, () => {});
      response = await abortable(pending, input.signal);
    } catch { checkAbort(input.signal); fail('SOURCE_REQUEST_FAILED', location); }
    if (!(response instanceof Response)) fail('INVALID_API_RESPONSE', location);
    try {
      checkAbort(input.signal);
      if (response.redirected) fail('UNSAFE_TRANSPORT_REDIRECT', location);
      if (response.url) sourceUrl(response.url, origin, secrets, policy);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get('location');
        if (!next) fail('MISSING_REDIRECT_LOCATION', location);
        url = sourceUrl(next, url, secrets, policy);
        retries = 0;
        continue;
      }
      if (response.status === 429 || ([403, 503].includes(response.status) && response.headers.has('retry-after'))) {
        if (retries >= maxRetries) fail('SOURCE_RATE_LIMIT', location);
        const ms = retryDelay(response.headers.get('retry-after'), retries, maxRetryAfterMs);
        discardBody(response);
        try { await abortable(Promise.resolve((input.sleep ?? sleep)(ms, input.signal)), input.signal); }
        catch { checkAbort(input.signal); fail('SOURCE_WAIT_FAILED', location); }
        retries++;
        continue;
      }
      if (!response.ok) fail('SOURCE_HTTP_ERROR', location);
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && Number(length) > budget.max - budget.used) fail('SOURCE_BYTE_LIMIT', location);
      const decoder = utf8Decoder(location);
      let text = '';
      const artifact = await consumeBytes(responseBytes(response, input.signal), budget, location, chunk => { text += decoder.decode(chunk); }, input.signal);
      text += decoder.decode(undefined, true);
      const { value, context } = parseApiJson(text, location, secrets, input);
      checkAbort(input.signal);
      let parsed: ReturnType<ApiSourceInput['parsePage']>;
      try { parsed = input.parsePage(value, page, context); } catch { fail('SOURCE_PARSER_FAILED', location); }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) fail('INVALID_PARSED_PAGE', location);
      if (parsed.next !== undefined && parsed.next !== null && (typeof parsed.next !== 'string' || !parsed.next)) fail('INVALID_NEXT_PAGE', location);
      collector.add(parsed.records, location, artifact.sha256);
      collector.bundle.artifacts.push({ name: location.artifact, ...artifact });
      checkAbort(input.signal);
      if (parsed.next === undefined || parsed.next === null) return collector.bundle;
      url = sourceUrl(parsed.next, url, secrets, policy);
      retries = 0; page++;
    } catch (error) {
      if (error instanceof ReaderError) throw error;
      checkAbort(input.signal); fail('SOURCE_READ_FAILED', location);
    } finally { discardBody(response); }
  }
}
