import { StepError } from '../errors'

const invalid = (): never => { throw new StepError('validation','Source DateTime requires a valid ISO timestamp with an explicit offset') }

/** Offset-bearing ISO timestamps have the same instant in source and native engines.
 * Local dates and other source parsers need an explicit source-zone conversion. */
export function n8nDateValue(value: unknown): number | null | undefined {
  if(value===null||value===undefined)return value
  if(typeof value!=='string')throw new StepError('type_mismatch','Source DateTime requires an ISO timestamp with an explicit offset')
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/i.exec(value)
  if(!match)return invalid()
  const [year,month,day,hour,minute,second]=[match[1],match[2],match[3],match[4],match[5],match[6]??'0'].map(Number)
  const milliseconds=Number((match[7]??'').slice(0,3).padEnd(3,'0')),offsetHours=Number(match[10]??0),offsetMinutes=Number(match[11]??0)
  if(hour>23||minute>59||second>59||offsetHours>23||offsetMinutes>59)return invalid()
  // setUTCFullYear preserves years below 100; Date.UTC interprets them as 1900s.
  const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,milliseconds)
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return invalid()
  const offset=(offsetHours*60+offsetMinutes)*(match[9]==='-'?-1:1)
  return date.getTime()-offset*60000
}
