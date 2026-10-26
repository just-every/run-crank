import { StepError } from '../errors'
import { isObject } from '../values'
import type { Transform } from './args'

const field = (value: unknown) => typeof value === 'string' && /^[_A-Za-z][_A-Za-z0-9]*$/.test(value) && !['__proto__','constructor','prototype'].includes(value)

/** Split one literal field using source JSON semantics; binary is never inferred. */
export const n8nSplit: Transform = args => {
  const source = args.source, name = args.field, destination = args.destination, include = args.include, max = args.max_items
  if (!isObject(source) || !field(name) || (destination !== '' && !field(destination)) || !['noOtherFields','allOtherFields','selectedOtherFields'].includes(String(include))
    || !Number.isSafeInteger(max) || Number(max)<1 || Number(max)>1000 || !Array.isArray(args.fields) || args.fields.some(value=>!field(value)))
    throw new StepError('validation','n8n Split Out needs a source object and reviewed literal field settings')
  const value = source[name as string]
  const values = value === undefined ? [] : Array.isArray(value) ? value : isObject(value) ? Object.values(value) : [value]
  if (values.length>Number(max)) throw new StepError('validation','n8n Split Out exceeds its reviewed source item bound')
  const items:Record<string,unknown>[]=[];let bytes=2
  for(const value of values){
    const target = String(destination || name)
    const split:Record<string,unknown> = destination === '' && include === 'noOtherFields' && value !== null && typeof value === 'object' ? {...value} : {[target]:value}
    let result=split
    if(include==='allOtherFields'){const original={...source};delete original[name as string];result={...original,...split}}
    if(include==='selectedOtherFields')for(const key of args.fields as string[])if(Object.hasOwn(source,key))split[key]=source[key]
    bytes+=new TextEncoder().encode(JSON.stringify(result)).length+(items.length?1:0)
    if(bytes>1024*1024)throw new StepError('validation','n8n Split Out exceeds the retained byte bound')
    items.push(result)
  }
  return items
}
