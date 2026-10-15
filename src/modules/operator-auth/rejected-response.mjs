const maximumDiscardBytes = 64 * 1024
const maximumDiscardMs = 2000

function limitedResponse(response, message, status) {
  const headers = new Headers(response.headers)
  // Keep privacy/security policy, but never issue credentials or a redirect
  // when the upload itself was refused.
  for (const name of ['set-cookie', 'location', 'content-length', 'content-encoding']) headers.delete(name)
  headers.set('content-type', 'text/plain; charset=utf-8')
  void response.body?.cancel().catch(() => {})
  return new Response(message, { status, headers })
}

/**
 * Finish a rejected upload before returning its response. This preserves the
 * intended status through workerd's upload proxy without buffering input.
 * Oversized or stalled uploads receive explicit 413/408 responses instead.
 */
export async function rejectedResponse(request, response) {
  if (!request.body || request.bodyUsed || request.body.locked) return response
  const reader = request.body.getReader()
  let bytes = 0
  let timer
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), maximumDiscardMs)
  })
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), deadline])
      if (result === 'timeout') {
        void reader.cancel('Rejected upload exceeded time limit').catch(() => {})
        return limitedResponse(response, 'Request body timeout', 408)
      }
      if (result.done) return response
      bytes += result.value.byteLength
      if (bytes > maximumDiscardBytes) {
        void reader.cancel('Rejected upload exceeded size limit').catch(() => {})
        return limitedResponse(response, 'Request body too large', 413)
      }
    }
  } finally {
    clearTimeout(timer)
  }
}
