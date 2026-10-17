// Run history for the demo workflow: the day's earlier payments (generated in one SQL
// statement per table) and the last eight told one by one, including the run that
// failed when Stripe renamed `amount` to `amount_total`, the read-back that kept a
// lost QuickBooks write from duplicating an invoice, and one approval still waiting.
import { StepError } from '../crank/engine/errors'
import { resolve } from '../crank/engine/mapping'
import type { Step } from '../crank/engine/types'
import { canonical, digest } from '../crank/model'
import type { CrankEnv } from '../crank/model'

export interface Story {
  id: string; customer: string; city: string; state: string; cents: number; ago: number; version: 1 | 2
  field: 'amount' | 'amount_total'; outcome: 'succeeded' | 'failed' | 'awaiting_approval'; invoice?: number; reconciled?: boolean; decidedAgo?: number
}
/** Newest first. Minutes before the demo starts; version 2 was published 27 minutes before. */
export const STORIES: Story[] = [
  { id: '4b7e21c9-58a3-4f0e-9d61-2c8f7a1e5b30', customer: 'Harbor Workshop LLC', city: 'Portland', state: 'OR', cents: 48000, ago: 2, version: 2, field: 'amount_total', outcome: 'succeeded', invoice: 4821 },
  { id: '9c03d6f2-1e47-4a8b-b5c2-7f61e0a93d14', customer: 'Acme Roofing', city: 'Denver', state: 'CO', cents: 125000, ago: 5, version: 2, field: 'amount_total', outcome: 'awaiting_approval' },
  { id: '2e9a4f17-c380-4d5b-8e26-91b7c4d0f6a2', customer: 'Lakeview Dental', city: 'Madison', state: 'WI', cents: 8900, ago: 8, version: 2, field: 'amount_total', outcome: 'succeeded', invoice: 4820 },
  { id: '71f5b8e3-0a26-4c94-a7d1-3e8c5f29b604', customer: 'Pine & Co.', city: 'Asheville', state: 'NC', cents: 231040, ago: 12, version: 2, field: 'amount_total', outcome: 'succeeded', invoice: 4819, decidedAgo: 10 },
  { id: 'c6d2a940-7b15-4e83-9f0a-58e1b3c7d29f', customer: 'Riverside Foods', city: 'Sacramento', state: 'CA', cents: 54000, ago: 15, version: 2, field: 'amount_total', outcome: 'succeeded', invoice: 4818 },
  { id: '5a8f3c61-d29e-4b07-81c4-e6f02a9b7d35', customer: 'Summit Health', city: 'Salt Lake City', state: 'UT', cents: 198000, ago: 21, version: 2, field: 'amount_total', outcome: 'succeeded', invoice: 4817, reconciled: true, decidedAgo: 19 },
  { id: 'e3b19d75-4f68-4a2c-b0e9-17d5c8a4f6e1', customer: 'Maple Retail', city: 'Burlington', state: 'VT', cents: 32000, ago: 31, version: 1, field: 'amount_total', outcome: 'failed' },
  { id: '0d6c8b42-a5f1-4e79-93b8-c2e4f7a16d58', customer: 'Cedar Systems', city: 'Austin', state: 'TX', cents: 76000, ago: 36, version: 1, field: 'amount', outcome: 'succeeded', invoice: 4816 },
]
export const V2_PUBLISHED_AGO = 27

/** Earlier customers, cycled through the day's generated payments (all under $1,000). */
const EARLIER = [
  ['Bluebird Bakery', 'Boise', 'ID'], ['Granite State Plumbing', 'Concord', 'NH'], ['Sunset Yoga', 'San Diego', 'CA'], ['Northfield Hardware', 'Northfield', 'MN'],
  ['Copper Kettle Cafe', 'Tucson', 'AZ'], ['Old Mill Books', 'Lancaster', 'PA'], ['Prairie Vet Clinic', 'Omaha', 'NE'], ['Bayside Marine', 'Annapolis', 'MD'],
  ['Juniper Florals', 'Bend', 'OR'], ['Redwood Tax Services', 'Eureka', 'CA'], ['Magnolia Catering', 'Savannah', 'GA'], ['Lone Star Movers', 'Houston', 'TX'],
  ['Brightside Cleaning', 'Columbus', 'OH'], ['Hilltop Auto', 'Knoxville', 'TN'], ['Canyon Outfitters', 'Flagstaff', 'AZ'], ['Evergreen Landscaping', 'Tacoma', 'WA'],
]

const iso = (ms: number) => new Date(ms).toISOString()
const dollars = (cents: number) => (cents / 100).toFixed(2)
const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
const slug = (id: string) => id.replace(/-/g, '').slice(0, 24)
const SHEET_ID = '1hK3vQ7sXcW2mSales2026'

function payload(s: Story, at: number) {
  return { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)' }, query: {}, files: [],
    body: { id: 'evt_' + slug(s.id), type: 'checkout.session.completed', created: Math.floor(at / 1000), data: { object: {
      id: 'cs_live_' + slug(s.id), [s.field]: s.cents, currency: 'usd', payment_status: 'paid',
      customer_details: { name: s.customer, email: `billing@${s.customer.toLowerCase().replace(/[^a-z]+/g, '')}.example`, address: { city: s.city, state: s.state, country: 'US' } },
    } } } }
}
function invoiceBody(s: Story, at: number) {
  const day = new Date(at), due = new Date(at + 30 * 86400000), date = (d: Date) => d.toISOString().slice(0, 10)
  return { Id: String(1000 + (s.invoice ?? 0) - 3800), DocNumber: String(s.invoice), TxnDate: date(day), DueDate: date(due), TotalAmt: Number(dollars(s.cents)), Balance: 0,
    CustomerRef: { value: String(200 + (s.invoice ?? 0) % 97), name: s.customer }, BillAddr: { City: s.city, CountrySubDivisionCode: s.state }, SalesTermRef: { name: 'Net 30' }, PrivateNote: 'cs_live_' + slug(s.id) }
}

/** The failure the executor records when a step's mapping cannot be resolved against this payload. */
function mappingFailure(step: Step, trigger: unknown, runId: string) {
  try { resolve(step.input ?? {}, { trigger, steps: {}, run: { id: runId } }); return null } catch (error) { return error instanceof StepError ? error.toJSON() : null }
}

/** Statements for the eight told runs, their steps and their approval waits. `graphs` are the published
 * versions' graphs: a failed run's error is the one the engine raises for its version's mapping. */
export async function storyStatements(env: CrankEnv, ids: { workflow: string; v1: string; v2: string; owner: string }, now: number, graphs: { 1: { steps: Step[] }; 2: { steps: Step[] } }) {
  const out: D1PreparedStatement[] = []
  for (const s of STORIES) {
    const at = now - s.ago * 60000, trigger = payload(s, at), large = s.cents > 100000
    const steps: [string, string, string, unknown, unknown, unknown, number][] = [] // path, step, type, input, output, error, seconds after receipt
    const step = (path: string, type: string, input: unknown, output: unknown, error: unknown, secs: number) => steps.push([path, path.split('/').at(-1)!, type, input, output, error, secs])
    step('paid_usd', 'filter', {}, { passed: true }, null, 0.4)
    const row = 1 + STORIES.length - STORIES.indexOf(s) + 1276
    const failure = s.outcome === 'failed' ? mappingFailure(graphs[s.version].steps.find(x => x.id === 'add_row')!, trigger, s.id) : null
    if (s.outcome === 'failed' && !failure) throw new Error(`Demo run ${s.id} is told as failed, but its version maps it`)
    if (failure) step('add_row', 'http', {}, null, failure, 0.6)
    else step('add_row', 'http', { method: 'POST', url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sales%202026!A1:append?valueInputOption=USER_ENTERED`, body: { values: [[s.customer, dollars(s.cents), 'cs_live_' + slug(s.id)]] } },
      { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' }, body: { spreadsheetId: SHEET_ID, tableRange: `'Sales 2026'!A1:C${row - 1}`, updates: { spreadsheetId: SHEET_ID, updatedRange: `'Sales 2026'!A${row}:C${row}`, updatedRows: 1, updatedColumns: 3, updatedCells: 3 } }, reconciled: false, attempts: 1 }, null, 1.6)
    if (s.outcome !== 'failed') {
      step('over_1000', 'paths', {}, { mode: 'exclusive', matched: large ? ['large', 'always'] : ['always'] }, null, 1.7)
      if (large) step('over_1000/large/post_sales', 'slack.send_channel_message', { channel: '#sales', text: `Payment over $1,000 from ${s.customer}, waiting for approval before the invoice` },
        { ok: true, channel: 'C07Q2SALES', ts: `${Math.floor(at / 1000) + 2}.004100`, thread_ts: null, text: `Payment over $1,000 from ${s.customer}, waiting for approval before the invoice` }, null, 2.4)
    }
    const proposal = { customer: s.customer, amount: usd(s.cents), terms: 'Net 30' }
    if (large && s.outcome !== 'failed') {
      const decided = s.decidedAgo === undefined ? null : now - s.decidedAgo * 60000
      const resolution = decided === null ? null : { approved: true, proposal, original: proposal, edited: false, reviewer: ids.owner, reason: null, decided_at: iso(decided) }
      out.push(env.DB.prepare('INSERT INTO crank_waits(id,run_id,path,kind,proposal_json,proposal_digest,reason,created_at,resolved_at,resolution_json,decided_by) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
        .bind(`demo-wait-${s.id}`, s.id, 'over_1000/large/approve_invoice', 'approval', canonical(proposal), await digest(canonical(proposal)), 'Payments over $1,000 wait for an owner before Crank creates the invoice.', iso(at + 2500),
          decided === null ? null : iso(decided), resolution === null ? null : JSON.stringify(resolution), decided === null ? null : ids.owner))
      if (resolution) step('over_1000/large/approve_invoice', 'approval', proposal, resolution, null, (decided! - at) / 1000)
      else steps.push(['over_1000/large/approve_invoice', 'approve_invoice', 'approval', proposal, null, null, -1])
    }
    if (s.invoice) {
      const base = large ? (s.decidedAgo! * -60 + s.ago * 60) : 2
      const body = invoiceBody(s, at)
      step('over_1000/always/create_invoice', 'http', { method: 'POST', url: 'https://quickbooks.api.intuit.com/v3/company/9130357/invoice?minorversion=75', body: { CustomerRef: { name: s.customer }, Line: [{ Amount: dollars(s.cents), DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { name: 'Services' } } }], SalesTermRef: { name: 'Net 30' }, PrivateNote: 'cs_live_' + slug(s.id) } },
        { status: 200, headers: { 'content-type': 'application/json' }, body: s.reconciled ? { QueryResponse: { Invoice: [body], startPosition: 1, maxResults: 1 } } : { Invoice: body }, reconciled: !!s.reconciled, attempts: s.reconciled ? 2 : 1 }, null, base + (s.reconciled ? 31 : 1.4))
    }
    const last = Math.max(...steps.map(x => x[6]))
    const finished = s.outcome === 'awaiting_approval' ? null : iso(at + last * 1000 + 200)
    const error = failure ? JSON.stringify({ ...failure, step: 'add_row' }) : null
    out.push(env.DB.prepare(`INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,source_time,received_at,started_at,finished_at,error_json,created_by,business_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .bind(s.id, ids.workflow, s.version === 1 ? ids.v1 : ids.v2, 'webhook', `key:${trigger.body.id}`, JSON.stringify(trigger), s.outcome, iso(at), iso(at), iso(at + 150), finished, error, ids.owner, `key:${trigger.body.id}`))
    let previous = at + 150
    for (const [path, stepId, type, input, output, stepError, secs] of steps) {
      const waiting = secs < 0, end = at + secs * 1000
      out.push(env.DB.prepare('INSERT INTO crank_wf_steps(run_id,path,step_id,type,status,input_json,output_json,error_json,started_at,finished_at,operation_key) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
        .bind(s.id, path, stepId, type, waiting ? 'waiting' : stepError ? 'failed' : 'succeeded', JSON.stringify(input), output === null ? null : JSON.stringify(output), stepError === null ? null : JSON.stringify(stepError), iso(previous), waiting ? null : iso(end), `${s.id}:${path}`))
      if (!waiting) previous = end
    }
  }
  return out
}

/** The day's earlier payments under version 1, evenly spaced from `start` to `end`. */
export function earlierStatements(env: CrankEnv, ids: { workflow: string; v1: string; owner: string }, count: number, start: number, end: number) {
  const step = Math.floor((end - start) / count), customers = JSON.stringify(EARLIER)
  const cte = `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<?1-1),
    c AS (SELECT CAST(key AS INTEGER) AS k, json_extract(value,'$[0]') AS name, json_extract(value,'$[1]') AS city, json_extract(value,'$[2]') AS st FROM json_each(?2)),
    g AS (SELECT i, ?3+i*?4 AS ms, ((i*7919)%89000)+2500 AS cents, c.name, c.city, c.st, printf('%08x-%04x-4%03x-a%03x-%06x%06x',(i*2654435761+97)%4294967296,(i*40503+31)%65536,(i*2731+5)%4096,(i*3301+9)%4096,(i*48271+11)%16777216,(i*69621+7)%16777216) AS id, printf('%06x%06x%06x%06x',(i*16807+3)%16777216,(i*40692+5)%16777216,(i*48271+19)%16777216,(i*69621+23)%16777216) AS tag FROM seq JOIN c ON c.k=i%?5)`
  const at = (offset: string) => `strftime('%Y-%m-%dT%H:%M:%fZ',(ms+${offset})/1000.0,'unixepoch')`
  const object = `json_object('id','cs_live_'||tag,'amount',cents,'currency','usd','payment_status','paid','customer_details',json_object('name',name,'email','billing@'||lower(replace(replace(name,' ',''),'''',''))||'.example','address',json_object('city',city,'state',st,'country','US')))`
  const binds = [count, customers, start, step, EARLIER.length]
  const prepare = (sql: string, ...extra: unknown[]) => env.DB.prepare(`${cte} ${sql}`).bind(...binds, ...extra)
  const stepRow = (path: string, type: string, input: string, output: string, from: string, to: string) => prepare(`INSERT INTO crank_wf_steps(run_id,path,step_id,type,status,input_json,output_json,started_at,finished_at,operation_key)
    SELECT id,'${path}','${path.split('/').at(-1)}','${type}','succeeded',${input},${output},${at(from)},${at(to)},id||':${path}' FROM g WHERE 1 ON CONFLICT DO NOTHING`)
  const dollars = `printf('%.2f',cents/100.0)`
  return [
    prepare(`INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,source_time,received_at,started_at,finished_at,created_by,business_key)
      SELECT id,?6,?7,'webhook','key:evt_'||tag,json_object('method','POST','headers',json_object('content-type','application/json; charset=utf-8'),'query',json_object(),'files',json_array(),
        'body',json_object('id','evt_'||tag,'type','checkout.session.completed','created',ms/1000,'data',json_object('object',${object}))),
        'succeeded',${at('0')},${at('0')},${at('150')},${at('3200')},?8,'key:evt_'||tag FROM g WHERE 1 ON CONFLICT DO NOTHING`, ids.workflow, ids.v1, ids.owner),
    stepRow('paid_usd', 'filter', `'{}'`, `'{"passed":true}'`, '150', '400'),
    stepRow('add_row', 'http', `json_object('method','POST','body',json_object('values',json_array(json_array(name,${dollars},'cs_live_'||tag))))`,
      `json_object('status',200,'body',json_object('spreadsheetId','${SHEET_ID}','updates',json_object('updatedRange','''Sales 2026''!A'||(i+2)||':C'||(i+2),'updatedRows',1)),'reconciled',json('false'),'attempts',1)`, '400', '1600'),
    stepRow('over_1000', 'paths', `'{}'`, `'{"mode":"exclusive","matched":["always"]}'`, '1600', '1700'),
    stepRow('over_1000/always/create_invoice', 'http', `json_object('method','POST','body',json_object('CustomerRef',json_object('name',name),'PrivateNote','cs_live_'||tag))`,
      `json_object('status',200,'body',json_object('Invoice',json_object('DocNumber',CAST(4815-(?1-1-i) AS TEXT),'TotalAmt',cents/100.0,'CustomerRef',json_object('name',name),'BillAddr',json_object('City',city,'CountrySubDivisionCode',st))),'reconciled',json('false'),'attempts',1)`, '1700', '3100'),
  ]
}
