import { slackCall } from './slack-request'
export { slackCall } from './slack-request'
import { credential } from '../connections/store'
import { StepError } from '../engine/errors'
import { searchKey, searchOutcome, validateSearch, withKeyLock } from '../engine/search'
import type { Step, StepContext, StepResult, StepType } from '../engine/types'
import { isObject } from '../engine/values'

const user = (u: any) => ({ id: u.id, name: u.name, real_name: u.real_name ?? u.profile?.real_name ?? null, display_name: u.profile?.display_name ?? null, email: u.profile?.email ?? null, is_bot: !!u.is_bot, team_id: u.team_id ?? null })
const channel = (c: any) => ({ id: c.id, name: c.name, is_private: !!c.is_private, is_archived: !!c.is_archived, num_members: c.num_members ?? null })
const message = (m: any, channelId: string) => ({ ts: m.ts, text: m.text ?? '', user: m.user ?? null, bot_id: m.bot_id ?? null, thread_ts: m.thread_ts ?? null, channel: channelId })

async function pages(ctx: StepContext, connectionId: string, method: string, params: Record<string, unknown>, key: string, maxPages = 50) {
  const items: any[] = []
  const visited = new Set<string>()
  let cursor = '', count = 0
  do {
    const page = await slackCall(ctx, connectionId, method, { ...params, cursor, limit: 200 }, false)
    if (!Array.isArray(page[key]) || page[key].some((item: unknown) => !isObject(item))) throw new StepError('provider', `Slack ${method} did not return its records array`)
    items.push(...page[key])
    cursor = page.response_metadata?.next_cursor ?? ''
    if (typeof cursor !== 'string' || cursor.length > 8192 || cursor && visited.has(cursor)) throw new StepError('provider', `Slack ${method} returned an invalid or repeated page cursor`)
    if (cursor) visited.add(cursor)
  } while (cursor && ++count < maxPages)
  return { items, truncated: !!cursor }
}
const normalizeName = (name: string) => name.trim().replace(/^#/, '').toLowerCase()
async function findChannels(ctx: StepContext, connectionId: string, name: string) {
  const wanted = normalizeName(name), result = await pages(ctx, connectionId, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: true }, 'channels')
  return { records: result.items.filter(c => c.name === wanted).map(channel), truncated: result.truncated }
}
async function lookupEmail(ctx: StepContext, connectionId: string, email: string) {
  try { return [user((await slackCall(ctx, connectionId, 'users.lookupByEmail', { email }, false)).user)] }
  catch (error) { if (error instanceof StepError && error.category === 'not_found') return []; throw error }
}
/** A channel input may be an ID or a #name; a name that resolves to nothing is `resource not found`. */
async function channelId(ctx: StepContext, connectionId: string, value: unknown) {
  const text = searchKey(value, 'channel')
  if (/^[CGD][A-Z0-9]{6,}$/.test(text)) return text
  const found = await findChannels(ctx, connectionId, text)
  if (found.truncated) throw new StepError('provider', 'Slack channel search is incomplete; no destination was selected')
  if (found.records.length !== 1) throw new StepError('validation', `resource not found: Slack channel ${text}`, { code: 'resource_not_found' })
  return found.records[0].id as string
}
async function customization(ctx: StepContext, connectionId: string, input: Record<string, unknown>) {
  if (input.username === undefined && input.icon_emoji === undefined && input.icon_url === undefined) return {}
  const { row } = await credential(ctx.env, connectionId), scopes: string[] = JSON.parse(row.scopes_json)
  if (scopes.length && !scopes.includes('chat:write.customize')) throw new StepError('auth', 'Posting with a custom name or icon needs the chat:write.customize scope')
  return { username: input.username, icon_emoji: input.icon_emoji, icon_url: input.icon_url }
}
async function mentions(ctx: StepContext, connectionId: string, input: Record<string, unknown>) {
  const tags: string[] = []
  for (const email of Array.isArray(input.mention_emails) ? input.mention_emails : []) {
    const found = await lookupEmail(ctx, connectionId, searchKey(email, 'mention email', 'email'))
    if (!found.length) throw new StepError('validation', `resource not found: no Slack user has ${email}`, { code: 'resource_not_found' })
    tags.push(`<@${found[0].id}>`)
  }
  for (const group of Array.isArray(input.mention_groups) ? input.mention_groups : []) tags.push(`<!subteam^${searchKey(group, 'user group')}>`)
  return tags.length ? tags.join(' ') + ' ' : ''
}
const connectionOf = (step: Step) => step.connection_id as string
const posted = (value: any) => ({ ok: true, channel: value.channel, ts: value.ts, thread_ts: value.message?.thread_ts ?? null, text: value.message?.text ?? null })

type Operation = (step: Step, ctx: StepContext) => Promise<StepResult>
const action = (required: string[], run: Operation): StepType => ({ mutating: true, connection: 'required', required, execute: run })
const search = (required: string[], run: Operation): StepType => ({ mutating: false, connection: 'required', required, validate: validateSearch, execute: run })

export const slackSteps: Record<string, StepType> = {
  'slack.send_channel_message': action(['channel', 'text'], async (step, ctx) => {
    const c = connectionOf(step), input = ctx.input
    const value = await slackCall(ctx, c, 'chat.postMessage', { channel: await channelId(ctx, c, input.channel), text: await mentions(ctx, c, input) + String(input.text), thread_ts: input.thread_ts, unfurl_links: input.unfurl_links, ...await customization(ctx, c, input) }, true)
    return { status: 'succeeded', output: posted(value) }
  }),
  'slack.send_direct_message': action(['text'], async (step, ctx) => {
    const c = connectionOf(step), input = ctx.input
    let userId = typeof input.user === 'string' ? input.user : null
    if (!userId) {
      const found = await lookupEmail(ctx, c, searchKey(input.email, 'email', 'email'))
      if (!found.length) throw new StepError('validation', `resource not found: no Slack user has ${String(input.email)}`, { code: 'resource_not_found' })
      userId = found[0].id
    }
    const opened = await slackCall(ctx, c, 'conversations.open', { users: userId }, true)
    const value = await slackCall(ctx, c, 'chat.postMessage', { channel: opened.channel.id, text: await mentions(ctx, c, input) + String(input.text), ...await customization(ctx, c, input) }, true)
    return { status: 'succeeded', output: { ...posted(value), user: userId } }
  }),
  'slack.reply_in_thread': action(['channel', 'thread_ts', 'text'], async (step, ctx) => {
    const c = connectionOf(step), input = ctx.input
    const value = await slackCall(ctx, c, 'chat.postMessage', { channel: await channelId(ctx, c, input.channel), thread_ts: input.thread_ts, reply_broadcast: input.broadcast === true ? true : undefined, text: await mentions(ctx, c, input) + String(input.text), ...await customization(ctx, c, input) }, true)
    return { status: 'succeeded', output: posted(value) }
  }),
  'slack.update_message': action(['channel', 'ts', 'text'], async (step, ctx) => {
    const c = connectionOf(step), value = await slackCall(ctx, c, 'chat.update', { channel: await channelId(ctx, c, ctx.input.channel), ts: ctx.input.ts, text: ctx.input.text }, true)
    return { status: 'succeeded', output: { ok: true, channel: value.channel, ts: value.ts, text: value.text ?? null } }
  }),
  'slack.delete_message': action(['channel', 'ts'], async (step, ctx) => {
    const c = connectionOf(step), value = await slackCall(ctx, c, 'chat.delete', { channel: await channelId(ctx, c, ctx.input.channel), ts: ctx.input.ts }, true)
    return { status: 'succeeded', output: { ok: true, channel: value.channel, ts: value.ts } }
  }),
  'slack.add_reaction': action(['channel', 'ts', 'name'], async (step, ctx) => {
    const c = connectionOf(step), name = String(ctx.input.name).replace(/^:|:$/g, '')
    try { await slackCall(ctx, c, 'reactions.add', { channel: await channelId(ctx, c, ctx.input.channel), timestamp: ctx.input.ts, name }, true) }
    catch (error) { if (!(error instanceof StepError && error.detail.slack_error === 'already_reacted')) throw error }
    return { status: 'succeeded', output: { ok: true, name } }
  }),
  'slack.find_user_by_email': search(['email'], async (step, ctx) => searchOutcome(step, await lookupEmail(ctx, connectionOf(step), searchKey(ctx.input.email, 'email', 'email')))),
  'slack.find_user_by_name': search(['name'], async (step, ctx) => {
    const wanted = searchKey(ctx.input.name, 'name').toLowerCase(), result = await pages(ctx, connectionOf(step), 'users.list', {}, 'members')
    const records = result.items.filter(u => !u.deleted && [u.name, u.real_name, u.profile?.real_name, u.profile?.display_name].some(n => typeof n === 'string' && n.trim().toLowerCase() === wanted)).map(user)
    return searchOutcome(step, records, result.truncated)
  }),
  'slack.find_channel_by_name': search(['name'], async (step, ctx) => {
    const c = connectionOf(step), name = normalizeName(searchKey(ctx.input.name, 'name'))
    const first = await findChannels(ctx, c, name)
    if (first.records.length || !isObject(step.create_if_not_found)) return searchOutcome(step, first.records, first.truncated)
    if (first.truncated) throw new StepError('provider', 'Slack channel search is incomplete; no create was dispatched')
    // Find or create: serialized per connection and key, with readback on a duplicate refusal.
    return withKeyLock(ctx.env, `slack-channel:${c}:${name}`, ctx.operationKey, async () => {
      const again = await findChannels(ctx, c, name)
      if (again.truncated) throw new StepError('provider', 'Slack channel search is incomplete; no create was dispatched')
      if (again.records.length) return searchOutcome(step, again.records)
      try {
        const created = await slackCall(ctx, c, 'conversations.create', { name, is_private: (step.create_if_not_found as Record<string, unknown>).is_private === true }, true)
        return { status: 'succeeded', output: { outcome: 'created', record: channel(created.channel), records: [channel(created.channel)], count: 1 } }
      } catch (error) {
        if (!(error instanceof StepError && error.detail.slack_error === 'name_taken')) throw error
        const readback = await findChannels(ctx, c, name)
        if (!readback.records.length) throw error
        return { status: 'succeeded', output: { outcome: 'found', record: readback.records[0], records: readback.records, count: readback.records.length } }
      }
    })
  }),
  'slack.find_message': search(['channel', 'text'], async (step, ctx) => {
    const c = connectionOf(step), id = await channelId(ctx, c, ctx.input.channel), wanted = searchKey(ctx.input.text, 'text').toLowerCase()
    const result = await pages(ctx, c, 'conversations.history', { channel: id }, 'messages', 5)
    return searchOutcome(step, result.items.filter(m => typeof m.text === 'string' && m.text.toLowerCase().includes(wanted)).map(m => message(m, id)), result.truncated)
  }),
}
