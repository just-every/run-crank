import { esc } from './document'
import { attemptTime } from './run-debug'

/** A scheduled release is not a send; retain both instants when Cron rounds a
 * connector wait or workflow concurrency delays the actual execution. */
export function retryHistory(attempt: any, runStatus: string) {
  if (!attempt.retry_at) return ''
  const scheduled = ` · next retry no earlier than ${attemptTime(attempt.retry_at)} (${esc(attempt.retry_reason)})`
  if (!attempt.retry_parked_at) return scheduled
  const pending = runStatus === 'cancelled' ? ' · retry cancelled; no further dispatch'
    : runStatus === 'failed' ? ' · retry stopped; inspect the run outcome'
    : runStatus === 'paused' ? ' · retry held while this run is paused'
    : attempt.retry_released_at ? '' : ' · waiting for the first due Cron tick (up to one minute later)'
  return `${scheduled} · execution slot released ${attemptTime(attempt.retry_parked_at)}${attempt.retry_released_at ? ` · Cron released ${attemptTime(attempt.retry_released_at)}` : ''}${attempt.retry_resumed_at ? ` · execution resumed ${attemptTime(attempt.retry_resumed_at)}` : pending}`
}
