import { parseDate } from '../dates'
import { StepError } from '../errors'

/** Offset-bearing ISO timestamps have the same instant in source and native engines.
 * Local dates and other source parsers need an explicit source-zone conversion. */
export function n8nDateValue(value: unknown): number | null | undefined {
  if(value===null||value===undefined)return value
  if(typeof value!=='string')throw new StepError('type_mismatch','Source DateTime requires an ISO timestamp with an explicit offset')
  const match=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-](\d{2})(?::?(\d{2}))?)$/i.exec(value)
  if(!match||Number(match[2]??0)>23||Number(match[3]??0)>59)throw new StepError('validation','Source DateTime requires an ISO timestamp with an explicit offset')
  const parsed=parseDate(value,'UTC')
  if(!parsed||!Number.isFinite(parsed.ms))throw new StepError('validation','Source DateTime timestamp is invalid')
  return parsed.ms
}
