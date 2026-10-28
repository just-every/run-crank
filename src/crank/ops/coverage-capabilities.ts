import { runTransform } from '../engine/transforms'
import { validateGroups } from '../engine/conditions'
import { validateGraph } from '../engine/graph'
import { validateSearch } from '../engine/search'
import { parseDate, requireUnit, requireZone } from '../engine/dates'
import { parseDecimal } from '../engine/decimal'
import { resolve } from '../engine/mapping'
import type { Step } from '../engine/types'
import { isObject, textOf } from '../engine/values'
import { n8nGraph } from '../n8n-graph'

/** Coverage declarations are deliberately smaller than the execution registry.
 * A missing declaration is unassessed capability, never inferred equivalence. */
export const COVERAGE_LIMITS = { items: 500, depth: 16, values: 20000, text: 4096, bytes: 262144 } as const
export interface InventoryItem {
  app: string; operation: string; source: string
  public_api?: 'openapi' | 'rest' | 'partner' | 'none'
  settings?: unknown; selected_resources?: unknown; extra_settings?: Record<string, unknown>
  source_kind: 'typed' | 'n8n' | 'make'; source_type?: string; source_version?: unknown
  source_options?: Record<string, unknown>; workflow_settings?: unknown
}
export const SEARCH_SETTING_KEYS = ['input', 'no_match', 'multi_match', 'on_multiple', 'limit', 'sort', 'create_if_not_found']
const SEARCH_FIELDS: Record<string, { input: string[]; sort: string[] }> = {
  find_channel_by_name: { input: ['name'], sort: ['id', 'name', 'is_private', 'is_archived', 'num_members'] },
  find_user_by_name: { input: ['name'], sort: ['id', 'name', 'real_name', 'display_name', 'email', 'is_bot', 'team_id'] },
  find_user_by_email: { input: ['email'], sort: ['id', 'name', 'real_name', 'display_name', 'email', 'is_bot', 'team_id'] },
}
export const CONDITION_OPTIONS: Record<string, string[]> = {
  text: ['value', 'case_sensitive', 'keep_whitespace', 'value_type'],
  number: ['value', 'value_type'], date: ['value', 'precision', 'timezone'],
  boolean: ['value_type'], exists: ['value_type'],
  'list.length': ['value', 'compare'], 'list.any': ['inner'], 'list.every': ['inner'],
}
export const TRANSFORM_ARGUMENTS: Record<string, string[]> = {
  'text.split': ['value', 'rule', 'separator', 'segment'], 'text.case': ['value', 'to'],
  'text.trim': ['value', 'collapse'], 'text.truncate': ['value', 'length', 'ellipsis'],
  'text.replace': ['value', 'find', 'replace', 'pattern', 'flags'],
  'text.length': ['value'], 'text.word_count': ['value'], 'text.url_encode': ['value'], 'text.url_decode': ['value'],
}
const fail = (code: string, reason: string) => ({ supported: false, code, reason })
const supported = { supported: true, code: 'supported_configuration', reason: 'Exact requested settings have a declared native capability' }
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
const own = (value: object, key: string) => Object.hasOwn(value, key)
const nonempty = (value: unknown) => typeof value === 'string' && !!value.trim()
const choice = (value: unknown, values: unknown[]) => value === undefined || values.includes(value)

function transformSettings(operation: string, settings: Record<string, unknown>) {
  const allowed = TRANSFORM_ARGUMENTS[operation]
  if (!allowed) return fail('undeclared_settings', 'Exact argument coverage is not declared for this native transform')
  if (!keys(settings, allowed)) return fail('unsupported_settings', 'Unknown transform argument; no exact capability is declared')
  if (!own(settings, 'value') || typeof settings.value !== 'string') return fail('incomplete_settings', 'This bounded transform declaration requires literal text input')
  let valid = true
  if (operation === 'text.split') valid = choice(settings.rule, ['separator', 'first_word', 'last_word']) && (settings.separator === undefined || typeof settings.separator === 'string') && (settings.segment === undefined || ['all', 'first', 'last'].includes(String(settings.segment)) || Number.isSafeInteger(settings.segment) && Number(settings.segment) >= 0)
  if (operation === 'text.case') valid = ['upper', 'lower', 'title', 'sentence'].includes(String(settings.to))
  if (operation === 'text.trim') valid = choice(settings.collapse, [true, false])
  if (operation === 'text.truncate') valid = Number.isSafeInteger(settings.length) && Number(settings.length) > 0 && choice(settings.ellipsis, [true, false])
  // Regex execution is not part of this bounded coverage door.
  if (operation === 'text.replace') valid = typeof settings.find === 'string' && typeof settings.replace === 'string' && choice(settings.pattern, [false]) && settings.flags === undefined
  if (valid) runTransform(operation, settings)
  return valid ? supported : fail('unsupported_settings', 'Transform options have no exact supported capability in this declaration')
}

function relativeDateSettings(value: unknown) {
  if (!isObject(value) || !own(value, 'relative')) return true
  if (!keys(value, ['relative', 'offset']) || typeof value.relative !== 'string' || !['now', 'today', 'start_of_week', 'start_of_month'].includes(value.relative)) return false
  if (value.offset !== undefined) {
    if (!isObject(value.offset) || !keys(value.offset, ['amount', 'unit']) || !Number.isSafeInteger(value.offset.amount)) return false
    requireUnit(value.offset.unit)
  }
  return true
}

function conditionOperand(rule: Record<string, unknown>, requested = rule.value, literal = false): boolean {
  const op = String(rule.op)
  if (requested === undefined) return !own(rule, 'value')
  if (!literal && isObject(requested)) {
    if (own(requested, '$literal')) return keys(requested, ['$literal']) && conditionOperand(rule, requested.$literal, true)
    if (own(requested, '$ref')) return keys(requested, ['$ref']) && nonempty(requested.$ref)
  }
  // Native data references are supported; their eventual values remain runtime
  // validation duties. No transform expression is executed to assess an operand.
  if (!literal && typeof requested === 'string' && /\{\{\s*[A-Za-z_][\w.\-[\]]*\s*\}\}/.test(requested)) return true
  if (rule.value_type !== undefined && typeof requested !== rule.value_type) return false
  if (op.startsWith('number.') || op === 'list.length') return parseDecimal(requested) !== null
  if (op.startsWith('date.')) return isObject(requested) && own(requested, 'relative')
    ? relativeDateSettings(requested) : parseDate(requested, requireZone(rule.timezone)) !== null
  if (op.startsWith('text.')) {
    if (['text.in', 'text.not_in'].includes(op) && Array.isArray(requested)) return requested.every(value => conditionOperand({ ...rule, op: 'text.equals', value }, value, literal))
    if (requested !== null && textOf(requested) === null) return false
    if (op.endsWith('matches')) new RegExp(String(requested))
    return true
  }
  return false
}

function conditionSettings(settings: Record<string, unknown>, paths: boolean) {
  const allowed = paths ? ['mode', 'branches', 'fallback', 'always', 'on_type_mismatch'] : ['when']
  if (!keys(settings, allowed)) return fail('unsupported_settings', 'Unknown filter or path option')
  // Check rule options too: native validation intentionally permits extra fields.
  const inspect = (groups: unknown): boolean => {
    validateGroups(groups, 'Coverage conditions')
    return (groups as unknown[][]).every(group => group.every(raw => {
      const rule = raw as Record<string, unknown>
      const op = String(rule.op), family = op.includes('.') ? op.split('.')[0] : 'exists'
      const options = CONDITION_OPTIONS[family === 'list' ? op : family]
      return !!options && keys(rule, ['field', 'op', ...options])
        && choice(rule.case_sensitive, [true, false]) && choice(rule.keep_whitespace, [true, false])
        && choice(rule.precision, ['instant', 'day'])
        && (!String(rule.op).startsWith('date.') || relativeDateSettings(rule.value))
        && conditionOperand(rule)
        && (rule.inner === undefined || inspect([[rule.inner]]))
    }))
  }
  if (!paths) return inspect(settings.when) ? supported : fail('unsupported_settings', 'Unknown or unsupported condition options')
  if (!Array.isArray(settings.branches) || !settings.branches.every(branch => isObject(branch) && keys(branch, ['id', 'when']) && inspect(branch.when))) return fail('incomplete_settings', 'Paths require declared branches and supported conditions')
  if (!['fallback', 'always'].every(key => settings[key] === undefined || settings[key] === true)) return fail('unsupported_settings', 'Fallback and always-run requirements must be explicit booleans')
  const step = { id: 'coverage', type: 'paths', ...settings, branches: settings.branches.map(branch => ({ ...branch, steps: [] })),
    ...(settings.fallback === true ? { fallback: { steps: [] } } : {}), ...(settings.always === true ? { always: { steps: [] } } : {}) }
  validateGraph({ trigger: { type: 'manual' }, steps: [step] })
  return supported
}

function sourceSettings(item: InventoryItem) {
  if (item.source_version === undefined) return fail('missing_source_version', 'Source version is required for configuration coverage')
  if (item.source_kind === 'make') return fail('source_mapping_unavailable', 'Make module settings have no committed native converter; operation availability does not establish migration coverage')
  // These compiler branches are pure and require no account, conversion grant or environment.
  const types = ['webhook', 'wait', 'set', 'dateTime', 'if', 'filter', 'switch'].map(type => 'n8n-nodes-base.' + type)
  if (!types.includes(item.source_type ?? '')) return fail('source_mapping_unavailable', 'This source node has no declared account-free setting mapping; native operation availability supplies no migration authority')
  // The compiler only maps replacement outputs for these modes. Do not let an
  // invalid source option look equivalent merely because it is not boolean true.
  if (isObject(item.settings)) {
    if (item.source_type === 'n8n-nodes-base.set' && !choice(item.settings.includeOtherFields, [false])) return fail('unsupported_source_configuration', 'Source field retention requires an explicitly supported replacement-output setting')
    if (item.source_type === 'n8n-nodes-base.dateTime' && item.settings.operation === 'formatDate' && isObject(item.settings.options) && !choice(item.settings.options.includeInputFields, [false])) return fail('unsupported_source_configuration', 'Source field retention requires an explicitly supported replacement-output setting')
  }
  const node = { ...item.source_options, id: 'coverage_node', name: 'Coverage node', position: [200, 0], type: item.source_type, typeVersion: item.source_version, parameters: item.settings }
  const start = { id: 'coverage_start', name: 'Coverage start', position: [0, 0], type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }
  const webhook = item.source_type === 'n8n-nodes-base.webhook'
  const workflow = { name: 'Coverage probe', nodes: webhook ? [node] : [start, node], settings: item.workflow_settings ?? {},
    connections: webhook ? {} : { 'Coverage start': { main: [[{ node: 'Coverage node', type: 'main', index: 0 }]] } } }
  const result = n8nGraph(workflow as any, 'coverage', {}, 'coverage')
  if (result.rejection) return fail('unsupported_source_configuration', 'Source version, options or expressions require manual conversion under the current native mapping')
  // Compilation proves the mapping, but literal dates must also satisfy execution.
  if (item.source_type === 'n8n-nodes-base.dateTime') {
    const effect = result.effects[0]?.value
    if (isObject(effect) && isObject(effect.graph) && Array.isArray(effect.graph.steps)) {
      for (const step of effect.graph.steps) {
        if (isObject(step) && step.fn === 'date.n8n_arithmetic' && isObject(step.input) && isObject(step.input.value) && own(step.input.value, '$literal')) {
          runTransform('date.n8n_arithmetic', resolve(step.input, { trigger: { input: {} }, steps: {}, run: {} }) as Record<string, unknown>)
        }
        if (isObject(step) && step.type === 'map' && isObject(step.input)) {
          for (const value of Object.values(step.input)) {
            if (isObject(value) && value.$fn === 'date.format' && isObject(value.args) && isObject(value.args.value) && own(value.args.value, '$literal')) {
              const args = resolve(value.args, { trigger: { input: {} }, steps: {}, run: {} }) as Record<string, unknown>
              if (args.value === null || args.value === undefined) return fail('incomplete_settings', 'Source date formatting requires a date input')
              runTransform('date.format', args)
            }
          }
        }
      }
    }
  }
  return supported
}

export function configurationCoverage(item: InventoryItem, operation: string) {
  try {
    if (item.extra_settings && Object.keys(item.extra_settings).length) return fail('unsupported_inventory_fields', 'Unrecognized inventory settings are retained but have no declared native mapping')
    if (item.source_kind === 'typed' && item.source_version !== undefined) return fail('source_mapping_unavailable', 'A source version in a typed list requires a supported source-format mapping')
    if (item.selected_resources !== undefined) return fail('resource_mapping_unavailable', 'Selected account resources need a supported current-account mapping; this report cannot establish that mapping')
    if (item.source_kind !== 'typed') return sourceSettings(item)
    if (!isObject(item.settings)) return fail('incomplete_settings', 'Exact configuration coverage requires a settings object')
    const settings = item.settings
    if (item.app === 'slack' && operation.startsWith('find_')) {
      if (!keys(settings, SEARCH_SETTING_KEYS)) return fail('unsupported_settings', 'Unknown search setting')
      validateSearch({ id: 'coverage', type: 'slack.' + operation, ...settings } as Step)
      if (operation === 'find_message') return fail('resource_mapping_unavailable', 'Selected Slack channel resources need current-account mapping proof that this report cannot establish')
      const fields = SEARCH_FIELDS[operation]
      if (!fields || !isObject(settings.input) || !keys(settings.input, fields.input) || !fields.input.every(field => nonempty((settings.input as Record<string, unknown>)[field]))) return fail('incomplete_settings', 'Search requires its exact typed lookup inputs')
      if (settings.create_if_not_found !== undefined && (operation !== 'find_channel_by_name' || !isObject(settings.create_if_not_found) || !keys(settings.create_if_not_found, ['is_private']) || !choice(settings.create_if_not_found.is_private, [true, false]))) return fail('unsupported_create', 'No matching create capability exists for these exact search settings')
      if (settings.sort !== undefined && (!isObject(settings.sort) || !keys(settings.sort, ['field', 'direction']))) return fail('unsupported_settings', 'Unknown search sort option')
      if (isObject(settings.sort) && !fields.sort.includes(String(settings.sort.field))) return fail('unsupported_sort', 'The requested sort field is not returned by this native search operation')
      return supported
    }
    if (item.app === 'formatter') return transformSettings(operation, settings)
    if (item.app === 'filter_paths') return conditionSettings(settings, operation === 'paths')
    return fail('undeclared_settings', 'Exact settings coverage is not declared for this native operation')
  } catch {
    // Compiler and validator errors can contain input text. Return a bounded value-free diagnostic.
    return fail('unsupported_settings', 'Requested settings are incomplete or rejected by the native capability validator')
  }
}
