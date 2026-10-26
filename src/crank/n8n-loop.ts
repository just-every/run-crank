import type { Step } from './engine/types'

type Node = Record<string, any>
export const linearN8nNodes = new Set(['n8n-nodes-base.set', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.executeWorkflow', 'n8n-nodes-base.code', 'n8n-nodes-base.limit', 'n8n-nodes-base.sort', 'n8n-nodes-base.removeDuplicates', 'n8n-nodes-base.aggregate'])

/** Topology only. Source expressions and node settings remain the graph compiler's responsibility. */
export function serialLoopRegions(nodes: Node[], edges: Map<number, number[][]>, batch: number) {
  const node = nodes[batch], parameters = node?.parameters ?? {}, outputs = edges.get(batch) ?? [], options = parameters.options ?? {}
  if (node?.type !== 'n8n-nodes-base.splitInBatches' || node.typeVersion !== 3 || !Number.isSafeInteger(parameters.batchSize ?? 1) || (parameters.batchSize ?? 1) < 1 || (parameters.batchSize ?? 1) > 1000
    || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key=>key!=='reset') || (options.reset!==undefined&&options.reset!==false)
    || outputs.length !== 2 || outputs[0].length > 1 || outputs[1].length !== 1)
    throw Error('loop requires version 3, a literal batch size from 1 to 1000, no reset and at most one distinct done path')
  const body: number[] = [], done: number[] = []
  let cursor = outputs[1][0]
  while (cursor !== batch) {
    if (body.includes(cursor) || !linearN8nNodes.has(nodes[cursor]?.type)) throw Error('loop body needs a linear mapped path returning to the batch node')
    body.push(cursor)
    const next = edges.get(cursor) ?? []
    if (next.length !== 1 || next[0].length !== 1) throw Error('loop body must return to the batch node')
    cursor = next[0][0]
  }
  if (outputs[0].length) {
    cursor = outputs[0][0]
    for (;;) {
      if (cursor === batch || body.includes(cursor) || done.includes(cursor)) throw Error('done path must be distinct from the loop body and contain no cycle')
      if (!linearN8nNodes.has(nodes[cursor]?.type)) throw Error('done path needs a linear Set, JSON HTTP or embedded synchronous subflow chain')
      done.push(cursor)
      const next = edges.get(cursor) ?? []
      if (next.length > 1 || next.some(branch => branch.length > 1)) throw Error('done path cannot fan out or reuse another branch')
      if (!next[0]?.length) break
      cursor = next[0][0]
    }
  }
  return { body, done }
}

const ref = (value: string) => ({ $ref: value })
function replaceCurrent(value: unknown, previous: string): unknown {
  if (Array.isArray(value)) return value.map(item => replaceCurrent(item, previous))
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  if ('$literal' in object) return object
  if (typeof object.$ref === 'string' && (object.$ref === previous || object.$ref.startsWith(previous + '.')))
    return { ...object, $ref: 'item' + object.$ref.slice(previous.length) }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, replaceCurrent(item, previous)]))
}

/** n8n runs each done-path node over the complete preceding stream. Separate
 * native loops preserve that node barrier rather than interleaving whole chains. */
export function itemStreamPipeline(steps: Step[], items: string, initial = 'item', maxItems = 1000) {
  const result: Step[] = []
  let stream = items, previous = initial
  for (const source of steps) {
    if(source.type==='code'&&source.n8n_items===true) {
      const batches=source.id+'_code_input',each=source.id+'_code',collected=source.id+'_items'
      result.push({id:batches,type:'transform',fn:'n8n.items',input:{kind:'code-batch',value:ref(stream),max_items:maxItems}},
        {id:each,name:source.name,type:'loop',input:{items:ref('steps.'+batches)},max_items:1,concurrency:1,order:'input',empty:'allow',item_errors:'stop',steps:[{...source,input:{$ref:'item'}}],result:ref('steps.'+source.id)},
        {id:collected,type:'transform',fn:'n8n.items',input:{kind:'code-results',value:ref('steps.'+each+'.results'),max_items:maxItems}})
      stream='steps.'+collected;previous=stream;continue
    }
    if(source.type==='transform'&&source.fn==='n8n.stream') {
      result.push({...source,input:{...(source.input as Record<string,unknown>),items:ref(stream),max_items:maxItems}})
      stream='steps.'+source.id;previous=stream;continue
    }
    if (!['map', 'http'].includes(source.type)) throw Error('done path has no committed item-stream conversion for this native operation')
    const each = source.id + '_each', collected = source.id + '_items'
    const step = { ...source, input: replaceCurrent(source.input ?? {}, previous) }
    result.push({ id: each, name: source.name, type: 'loop', input: { items: ref(stream) }, max_items: maxItems, concurrency: 1,
      order: 'input', empty: 'allow', item_errors: 'stop', steps: [step], result: ref('steps.' + source.id) })
    stream = 'steps.' + each + '.results'
    if (source.type === 'http') {
      result.push({ id: collected, type: 'transform', fn: 'n8n.items', input: { kind: 'responses', value: ref(stream), max_items: maxItems } })
      stream = 'steps.' + collected
    }
    previous = 'steps.' + source.id + (source.type === 'http' ? '.body' : '')
  }
  return { steps: result, output: stream }
}

/** Additional item expansion needs explicit reviewed bounds. These participate
 * in source identity and the native graph's aggregate invocation calculation. */
export function reviewedStreamBounds(choice: Node | undefined) {
  if (!choice || !['item-stream-loop','item-stream'].includes(choice.kind) || choice.reviewed !== true)
    throw Error('intermediate HTTP item expansion requires an owner-reviewed item-stream-loop conversion and explicit bounds')
  if (Object.keys(choice).some(key => !['kind', 'reviewed', 'max_source_items', 'max_stage_items'].includes(key))
    || ![choice.max_source_items, choice.max_stage_items].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 1000))
    throw Error('item-stream-loop conversion requires source and stage bounds from 1 to 1000 within the native invocation budget')
  return { source: choice.max_source_items as number, stage: choice.max_stage_items as number }
}
