// One buyer's week and month with Crank, in the order the homepage meets it (desk page-s1, 17 Oct 2026):
// Fernhill Packaging moves in on Monday, Oct 26, 2026; the hero's run (Harbor Supply Co., $480.00) is traced on
// Tuesday, Oct 27; Shopify goes down that afternoon; Stripe renames a field that night; the books close on
// Friday, Oct 30. Every figure that appears in two sections comes from here.
import type { App } from './parts'

export const business = { name: 'Fernhill Packaging', owner: 'Dana Reyes', initials: 'DR' }

/** Monday morning: the Zapier export, rebuilt and checked against past runs (MIG-002). */
export type Imported = { from: App; to: App; trigger: string; action: string; steps: number; note?: string; matched?: [number, number]; question?: string }
export const imported: Imported[] = [
  { from: 'stripe', to: 'quickbooks', trigger: 'Stripe payment', action: 'QuickBooks invoice', steps: 5, matched: [212, 212] },
  { from: 'shopify', to: 'slack', trigger: 'New Shopify order', action: 'Slack #fulfillment', steps: 3, matched: [486, 486] },
  { from: 'gmail', to: 'sheets', trigger: 'Gmail invoices', action: 'Google Sheets', steps: 4, matched: [97, 97] },
  { from: 'typeform', to: 'hubspot', trigger: 'Typeform lead', action: 'HubSpot deal', steps: 6, note: 'Formatter → code step', matched: [41, 41] },
  { from: 'zendesk', to: 'sheets', trigger: 'Refund request', action: 'Finance', steps: 4, question: 'Paths step has no default. Send other refunds to Finance or Support?' },
]
export const importTotals = { zaps: 38, running: 37, questions: 1 }

/** Tuesday, 9:14 AM: the hero's payment through every step of its workflow. */
export const run = {
  number: '1,412',
  workflow: ['Stripe payment', 'QuickBooks invoice'] as const,
  customer: 'Harbor Supply Co.',
  amount: '$480.00',
}
export type RunStep = { app: App; title: string; lines: string[]; time: string; note?: string }
export const runSteps: RunStep[] = [
  { app: 'stripe', title: 'New payment', lines: ['amount: 48000', 'customer: Harbor Supply Co.'], time: '9:14:02' },
  { app: 'sheets', title: 'Add row', lines: ['Orders 2026 · row 2,114', '$480.00 · Harbor Supply Co.'], time: '9:14:03' },
  { app: 'ai', title: 'AI step · Summarize', lines: ['“Third reorder this month:', '40 cases of kraft mailers.”'], time: '9:14:05' },
  { app: 'slack', title: 'Post in #sales', lines: ['Harbor Supply Co. paid $480.00.', 'Third reorder this month.'], time: '9:14:06' },
  { app: 'quickbooks', title: 'Create invoice', lines: ['INV-4161 · $480.00 · Paid'], time: '9:15:43', note: 'Rate limited · retried after 90s' },
]
/** The mapping the overnight repair changes: Stripe's `amount` becomes `amount_total`. */
export const mapping = [
  { from: 'amount ÷ 100', to: 'Amount (USD)' },
  { from: 'customer.name', to: 'Customer' },
  { from: 'metadata.po (blank)', to: '“none”' },
]

/** Tuesday, all day: eight of the day's runs, by trigger. */
export type LogTone = 'done' | 'skipped' | 'failing'
export type LogRow = { time: string; app: App; text: string; status: string; tone: LogTone }
export const today = { runs: '1,284', lost: 0 }
export const log: LogRow[] = [
  { time: '9:00 AM', app: 'schedule', text: 'Schedule · Weekday stock report', status: 'Completed', tone: 'done' },
  { time: '9:02 AM', app: 'gmail', text: 'Invoice from Pine Street Print → Sheets', status: 'Completed', tone: 'done' },
  { time: '9:04 AM', app: 'gmail', text: 'Same invoice, sent twice', status: 'Duplicate skipped', tone: 'skipped' },
  { time: '9:14 AM', app: 'stripe', text: 'Harbor Supply Co. · $480.00 → QuickBooks', status: 'Completed', tone: 'done' },
  { time: '10:37 AM', app: 'shopify', text: 'Refund $1,250 · Order #4729 → QuickBooks credit memo', status: 'Completed', tone: 'done' },
  { time: '11:20 AM', app: 'typeform', text: 'Priya Shah · Fieldstone Dental · AI score 9', status: 'Posted to #sales', tone: 'done' },
  { time: '1:05 PM', app: 'webhook', text: 'Carrier tracking update · 3 orders', status: 'Completed', tone: 'done' },
  { time: '2:31 PM', app: 'shopify', text: 'Order sync', status: 'Failing · retrying', tone: 'failing' },
]

/** Tuesday, 2:31 PM: Shopify answers 503; backoff doubles from 1 to 16 minutes, then 200 OK. */
export const outage = {
  waiting: 23,
  attempts: ['2:31 PM', '2:32 PM', '2:34 PM', '2:38 PM', '2:46 PM'],
  recovered: '3:02 PM',
  messages: [
    { time: '2:46 PM', lines: ['Shopify returning 503 since 2:31 PM.', '23 order runs waiting, none lost.'] },
    { time: '3:04 PM', lines: ['Recovered 3:02 PM.', 'All 23 runs completed in order.'], done: true },
  ],
}

/** Overnight: Stripe renames `amount`; the agent repairs, tests, reconciles and asks one business question. */
export type AgentTone = 'failed' | 'read' | 'edit' | 'done' | 'asked'
export type AgentRow = { time: string; tone: AgentTone; text: string; diff?: [string, string] }
export const agentLog: AgentRow[] = [
  { time: '11:48 PM', tone: 'failed', text: 'Create invoice failed: field “amount” not found · runs held' },
  { time: '11:49 PM', tone: 'read', text: 'Read Stripe changelog: amount renamed to amount_total' },
  { time: '11:51 PM', tone: 'edit', text: 'Mapping updated: Amount (USD)', diff: ['amount', 'amount_total'] },
  { time: '11:56 PM', tone: 'done', text: 'Tested on the last 20 runs · 20 passed' },
  { time: '12:02 AM', tone: 'done', text: 'Checked 2 uncertain writes in QuickBooks · 1 landed, 1 missing, sent once' },
  { time: '12:04 AM', tone: 'done', text: 'Workflow resumed · 3 held runs replayed' },
  { time: '12:05 AM', tone: 'asked', text: 'Asked Dana Reyes: New method “ACH pending”. Invoice as Paid now, or on settlement?' },
]
export const answer = { text: 'On settlement.', time: '8:12 AM' }

/** Friday, October 30: Stripe and QuickBooks agree for the month, after three fixes on their side. */
export const close = {
  month: 'October',
  payments: '1,912',
  total: '$148,920.40',
  fixes: [
    { who: 'Northwind Café', amount: '$86.00', cause: 'invoice missing', fix: 'Created', ref: 'INV-4410' },
    { who: 'Bay Street Deli', amount: '$1,175.00', cause: 'payment not applied', fix: 'Applied to', ref: 'INV-4398' },
    { who: 'Oak & Ivy Florals', amount: '$64.00', cause: 'refunded in Stripe', fix: 'Credit memo', ref: 'CM-212' },
  ],
}
