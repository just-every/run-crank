import { LIMITS, OPERATORS } from '../engine/conditions'
import { PATH_LIMITS } from '../engine/graph'
import { TRANSFORMS } from '../engine/transforms'
import { POLL_INTERVALS } from '../triggers/definition'
import { SIGNATURE_PRESETS } from '../triggers/signatures'
import { PROVIDERS } from './oauth'

const SEARCH_OUTCOMES = { outcomes: ['found', 'not found', 'multiple matches'], no_match: ['halt', 'continue'], multi_match: ['first', 'stop', 'all'] }
const op = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, ...extra })

/** Native apps and built-in tools that exist in this installation, with their exact operations. */
export const CATALOG = [
  { app: 'webhooks', name: 'Webhooks', clauses: ['TRIG-001', 'HTTP-002'], auth: ['none', 'signature', 'header secret'],
    triggers: [op('catch_hook', 'Catch hook (secret URL, POST/PUT/GET, JSON/form/multipart/XML/raw)', { trigger: 'webhook', signature_presets: SIGNATURE_PRESETS, dedup: 'key path or SHA-256 body digest, 1 minute to 30 days', responses: ['immediate', 'sync'] })],
    actions: [op('request', 'API request (GET, POST, PUT, PATCH, DELETE, HEAD)', { step: 'http', bodies: ['json', 'form', 'multipart', 'xml', 'raw'], auth: ['bearer', 'basic', 'api_key', 'hmac', 'oauth2', 'oauth2_client_credentials'], pagination: ['cursor', 'page', 'link'] })], searches: [] },
  { app: 'schedule', name: 'Schedule', clauses: ['TRIG-002'], triggers: [op('every', 'Every N minutes', { trigger: 'schedule' }), op('daily', 'Daily, weekday or monthly time in an IANA timezone', { trigger: 'schedule', business_days: 'us_federal or custom calendar' })], actions: [], searches: [] },
  { app: 'rss', name: 'RSS, Atom and JSON Feed', clauses: ['TRIG-007'], triggers: [op('new_item', 'New item in one or several feeds', { trigger: 'feed', intervals_minutes: POLL_INTERVALS })], actions: [], searches: [] },
  { app: 'retrieve_poll', name: 'URL poll (Retrieve Poll)', clauses: ['TRIG-007'], triggers: [op('new_record', 'New record at a JSON path or XPath', { trigger: 'url_poll', pagination: ['cursor', 'page', 'link'], intervals_minutes: POLL_INTERVALS })], actions: [], searches: [] },
  { app: 'formatter', name: 'Formatter', clauses: ['WORK-012', 'WORK-002'], triggers: [], actions: Object.keys(TRANSFORMS).map(name => op(name, name, { step: 'transform' })), searches: [] },
  { app: 'filter_paths', name: 'Filter and Paths', clauses: ['WORK-013'], operators: OPERATORS, limits: { rules_per_group: LIMITS.rulesPerGroup, groups: LIMITS.groups, branches: PATH_LIMITS.branches, nesting: PATH_LIMITS.depth }, triggers: [], actions: [op('filter', 'Filter', { step: 'filter' }), op('paths', 'Paths (exclusive or parallel, fallback or always-run)', { step: 'paths' })], searches: [] },
  { app: 'delay', name: 'Delay', clauses: ['WORK-004'], triggers: [], actions: [op('delay_for', 'Delay for (minutes to weeks, or business days)', { step: 'delay', mode: 'for' }), op('delay_until', 'Delay until', { step: 'delay', mode: 'until' }), op('delay_queue', 'Delay queue (named, shared, spaced)', { step: 'delay', mode: 'queue' }), op('wait_for_callback', 'Wait for a callback', { step: 'wait_for_callback' })], searches: [] },
  { app: 'approvals', name: 'Approvals', clauses: ['TEAM-005', 'TEAM-004'], triggers: [], actions: [op('approval', 'Approval with editable, capped fields', { step: 'approval' })], searches: [] },
  { app: 'files', name: 'Files', clauses: ['WORK-002'], triggers: [], actions: [op('fetch', 'Fetch a public file URL into a file reference', { step: 'file.fetch', max_bytes: 1048576 })], searches: [] },
  { app: 'slack', name: 'Slack', clauses: ['CONN-004'], auth: ['oauth2', 'bearer (bot token)'], oauth: !!PROVIDERS.slack, api_version: 'Slack Web API', domains: ['slack.com'],
    scopes: ['chat:write', 'chat:write.customize', 'im:write', 'users:read', 'users:read.email', 'channels:read', 'groups:read', 'channels:history', 'channels:manage', 'reactions:write'],
    triggers: [op('new_message', 'New message posted to a channel', { trigger: 'slack_event', event: 'message' }), op('new_mention', 'New mention of a chosen user', { trigger: 'slack_event', event: 'mention' }), op('app_mention', 'New mention of the connection', { trigger: 'slack_event', event: 'app_mention' }), op('new_reaction', 'New reaction added', { trigger: 'slack_event', event: 'reaction_added' })],
    actions: ['send_channel_message', 'send_direct_message', 'reply_in_thread', 'update_message', 'delete_message', 'add_reaction'].map(name => op(name, name.replace(/_/g, ' '), { step: 'slack.' + name })),
    searches: ['find_user_by_email', 'find_user_by_name', 'find_channel_by_name', 'find_message'].map(name => op(name, name.replace(/_/g, ' '), { step: 'slack.' + name, ...SEARCH_OUTCOMES, create_if_not_found: name === 'find_channel_by_name' })),
    pagination: 'cursor', limits: 'Slack tier rate limits; Retry-After honoured', restrictions: ['Messages from bots never start Slack triggers', 'Custom name and icon need chat:write.customize'], needs_account: true },
]

/** Apps on Zapier’s popular-apps list (16 Oct 2026) and the named SMB apps, with the clause that commits them. */
export const PLANNED: Record<string, { name: string; clause: string; api: 'openapi' | 'rest' | 'partner' }> = {
  google_sheets: { name: 'Google Sheets', clause: 'CONN-005', api: 'rest' }, google_drive: { name: 'Google Drive', clause: 'CONN-005', api: 'rest' }, airtable: { name: 'Airtable', clause: 'CONN-005', api: 'rest' },
  gmail: { name: 'Gmail', clause: 'CONN-003', api: 'rest' }, microsoft_outlook: { name: 'Microsoft Outlook', clause: 'CONN-003', api: 'openapi' },
  hubspot: { name: 'HubSpot', clause: 'CONN-006', api: 'openapi' }, salesforce: { name: 'Salesforce', clause: 'CONN-006', api: 'rest' }, stripe: { name: 'Stripe', clause: 'CONN-008', api: 'openapi' },
  facebook_lead_ads: { name: 'Facebook Lead Ads', clause: 'CONN-012', api: 'rest' }, google_forms: { name: 'Google Forms', clause: 'CONN-012', api: 'rest' }, typeform: { name: 'Typeform', clause: 'CONN-012', api: 'rest' },
  jotform: { name: 'Jotform', clause: 'CONN-012', api: 'rest' }, gravity_forms: { name: 'Gravity Forms', clause: 'CONN-012', api: 'rest' }, google_calendar: { name: 'Google Calendar', clause: 'CONN-013', api: 'rest' },
  calendly: { name: 'Calendly', clause: 'CONN-013', api: 'openapi' }, notion: { name: 'Notion', clause: 'CONN-014', api: 'rest' }, trello: { name: 'Trello', clause: 'CONN-014', api: 'openapi' },
  monday: { name: 'monday.com', clause: 'CONN-014', api: 'rest' }, google_docs: { name: 'Google Docs', clause: 'CONN-014', api: 'rest' }, mailchimp: { name: 'Mailchimp', clause: 'CONN-015', api: 'openapi' },
  leadconnector: { name: 'LeadConnector', clause: 'CONN-015', api: 'openapi' }, microsoft_excel: { name: 'Microsoft Excel', clause: 'CONN-005', api: 'openapi' }, onedrive: { name: 'OneDrive', clause: 'CONN-005', api: 'openapi' },
  sharepoint: { name: 'SharePoint', clause: 'CONN-005', api: 'openapi' }, zoom: { name: 'Zoom', clause: 'CONN-013', api: 'openapi' }, asana: { name: 'Asana', clause: 'CONN-014', api: 'openapi' },
  clickup: { name: 'ClickUp', clause: 'CONN-014', api: 'openapi' }, pipedrive: { name: 'Pipedrive', clause: 'CONN-015', api: 'openapi' }, dropbox: { name: 'Dropbox', clause: 'CONN-016', api: 'rest' },
  box: { name: 'Box', clause: 'CONN-016', api: 'openapi' }, docusign: { name: 'DocuSign', clause: 'CONN-016', api: 'openapi' }, pandadoc: { name: 'PandaDoc', clause: 'CONN-016', api: 'openapi' },
  twilio: { name: 'Twilio', clause: 'CONN-017', api: 'openapi' }, square: { name: 'Square', clause: 'CONN-018', api: 'openapi' }, paypal: { name: 'PayPal', clause: 'CONN-018', api: 'openapi' },
  woocommerce: { name: 'WooCommerce', clause: 'CONN-018', api: 'rest' }, quickbooks: { name: 'QuickBooks Online', clause: 'CONN-007', api: 'openapi' }, xero: { name: 'Xero', clause: 'CONN-007', api: 'openapi' },
  netsuite: { name: 'NetSuite', clause: 'CONN-007', api: 'rest' }, shopify: { name: 'Shopify', clause: 'CONN-008', api: 'rest' }, zendesk: { name: 'Zendesk', clause: 'CONN-009', api: 'openapi' },
  jira: { name: 'Jira Software Cloud', clause: 'CONN-009', api: 'openapi' }, microsoft_teams: { name: 'Microsoft Teams', clause: 'CONN-004', api: 'openapi' },
  openai: { name: 'ChatGPT (OpenAI)', clause: 'AI-001', api: 'openapi' }, anthropic: { name: 'Anthropic (Claude)', clause: 'AI-001', api: 'openapi' },
}
