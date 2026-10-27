type Obj = Record<string, any>
type Fields = (value: Obj, allowed: string[], at: string) => void
const object = (value: unknown): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Sheets trigger settings require an object')
  return value
}
const literal = (value: unknown, name: string, max = 160): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith('=') || value.includes('{{')) throw Error(name + ' requires literal text')
  return value
}

/** Source format: n8n GoogleSheetsTrigger.node.ts v1 and workflow/node-helpers.ts.
 * n8n compares Drive revisions by row position. A reviewed conversion explicitly
 * chooses native stable-key observations; it does not claim revision-history parity.
 */
export function n8nSheetsTrigger(node: Obj, choice: Obj | undefined, at: string, fields: Fields): Obj {
  const p = object(node.parameters ?? {}), options = object(p.options ?? {})
  fields(p, ['authentication', 'documentId', 'sheetName', 'event', 'includeInOutput', 'options', 'pollTimes'], at + '.parameters')
  fields(options, ['columnsToWatch', 'dataLocationOnSheet', 'valueRender', 'dateTimeRenderOption'], at + '.parameters.options')
  if (node.typeVersion !== 1 || !['rowUpdate', 'rowAdded'].includes(p.event)) throw Error('Sheets trigger needs version 1 and explicit rowUpdate or rowAdded; anyUpdate needs manual conversion')
  if (!['triggerOAuth2', 'serviceAccount'].includes(p.authentication ?? 'triggerOAuth2')) throw Error('Sheets authentication has no supported fresh-binding mapping')
  fields(object(node.credentials ?? {}), [(p.authentication ?? 'triggerOAuth2') === 'serviceAccount' ? 'googleApi' : 'googleSheetsTriggerOAuth2Api'], at + '.credentials')
  if ((p.includeInOutput ?? 'new') !== 'new') throw Error('Sheets includeInOutput old/both requires manual output conversion')
  if (options.valueRender !== undefined && options.valueRender !== 'UNFORMATTED_VALUE') throw Error('Sheets valueRender requires UNFORMATTED_VALUE')
  if (options.dateTimeRenderOption !== undefined && options.dateTimeRenderOption !== 'SERIAL_NUMBER' || p.event === 'rowAdded' && options.dateTimeRenderOption !== 'SERIAL_NUMBER') throw Error('Sheets dateTimeRenderOption needs explicit SERIAL_NUMBER for added rows')
  const locator = (raw: unknown, name: string) => {
    const value = object(raw)
    fields(value, ['__rl', 'mode', 'value', 'cachedResultName', 'cachedResultUrl'], at + '.parameters.' + name)
    if (value.__rl !== true || !['id', 'list'].includes(value.mode)) throw Error('Sheets ' + name + ' requires an id/list resource locator; URL/expression locators need manual conversion')
    if (value.cachedResultName !== undefined) literal(value.cachedResultName, name + '.cachedResultName', 2048)
    if (value.cachedResultUrl !== undefined) literal(value.cachedResultUrl, name + '.cachedResultUrl', 2048)
    return value.value
  }
  const spreadsheet = literal(locator(p.documentId, 'documentId'), 'spreadsheet ID')
  if (!/^[A-Za-z0-9_-]+$/.test(spreadsheet)) throw Error('Sheets documentId must be a literal spreadsheet ID')
  const gid = locator(p.sheetName, 'sheetName')
  if (!(typeof gid === 'number' && Number.isSafeInteger(gid) && gid >= 0 || typeof gid === 'string' && /^(?:gid=)?\d+$/.test(gid))) throw Error('Sheets sheetName must identify a numeric sheet ID')
  const location = object(options.dataLocationOnSheet), values = object(location.values)
  fields(location, ['values'], at + '.parameters.options.dataLocationOnSheet')
  fields(values, ['rangeDefinition', 'range'], at + '.parameters.options.dataLocationOnSheet.values')
  if (values.rangeDefinition !== 'specifyRangeA1') throw Error('Sheets requires an explicit A1 range with headers in row 1')
  const range = literal(values.range, 'Sheets range')
  if (!/^A1:[A-Z]+(?:[1-9]\d*)?$/.test(range)) throw Error('Sheets range requires uppercase A1 notation starting at header row 1')
  const polling = object(p.pollTimes)
  fields(polling, ['item'], at + '.parameters.pollTimes')
  if (!Array.isArray(polling.item) || polling.item.length !== 1) throw Error('Sheets pollTimes requires one explicit interval')
  const rule = object(polling.item[0])
  fields(rule, rule.mode === 'everyX' ? ['mode', 'value', 'unit'] : ['mode'], at + '.parameters.pollTimes.item.0')
  let interval: number
  if (rule.mode === 'everyMinute') interval = 1
  else if (rule.mode === 'everyX' && Number.isInteger(rule.value) && rule.value > 0 && ['minutes', 'hours'].includes(rule.unit)) interval = rule.value * (rule.unit === 'hours' ? 60 : 1)
  else throw Error('Sheets pollTimes mode requires manual schedule conversion')
  if (![1, 2, 5, 15, 30, 60].includes(interval) && !(interval % 60 === 0 && interval <= 1440)) throw Error('Sheets pollTimes interval has no exact native polling interval')
  const columns = options.columnsToWatch
  if (columns !== undefined && (!Array.isArray(columns) || columns.length > 30 || new Set(columns).size !== columns.length)) throw Error('Sheets columnsToWatch requires at most 30 unique literal column names')
  for (const column of columns ?? []) literal(column, 'Watched column')
  if (p.event === 'rowAdded' && columns !== undefined) throw Error('Sheets rowAdded columnsToWatch is inactive and needs manual conversion')
  if (!choice || choice.kind !== 'sheets-trigger' || choice.reviewed !== true) throw Error('Sheets trigger requires an explicit reviewed sheets-trigger conversion with a fresh native connection, stable key and sheet title')
  fields(choice, ['kind', 'reviewed', 'connection_id', 'key_field', 'sheet_name', 'comparison'], 'conversions.' + node.id)
  if (Object.keys(choice).some(key => !['kind', 'reviewed', 'connection_id', 'key_field', 'sheet_name', 'comparison'].includes(key))) throw Error('Sheets trigger conversion contains an unsupported setting')
  if (choice.comparison !== 'stable_key_current_rows') throw Error('Review stable_key_current_rows: native polling observes current rows by stable key, not Drive revision history or source row numbers')
  const connection = literal(choice.connection_id, 'Fresh native connection'), key = literal(choice.key_field, 'Stable key column'), title = literal(choice.sheet_name, 'Resolved sheet title')
  if (/[!\[\]:*?/\\]/u.test(title)) throw Error('Resolved sheet title contains unsupported range characters')
  return { type: 'app_poll', provider: 'google_sheets', resource: 'rows', connection_id: connection, spreadsheet_id: spreadsheet,
    range: "'" + title.replaceAll("'", "''") + "'!" + range, key_field: key, event: p.event === 'rowAdded' ? 'new' : 'updated',
    ...(columns?.length ? { watched_fields: [...columns] } : { any_field: true }), backfill: 'from_now', identity: 'change', interval_minutes: interval }
}
