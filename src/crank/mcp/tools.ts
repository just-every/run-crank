type Input = Record<string, unknown>
interface Tool { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }; method: 'GET' | 'POST'; path: (a: Input) => string; body?: (a: Input) => unknown }
const string = { type: 'string', minLength: 1 }, object = { type: 'object' }
const part = (a: Input, key: string) => encodeURIComponent(String(a[key]))
const tool = (name: string, description: string, method: 'GET' | 'POST', path: Tool['path'], properties: Record<string, unknown> = {}, required: string[] = [], body?: Tool['body']): Tool => ({ name, description, method, path, body, inputSchema: { type: 'object', properties, required, additionalProperties: false } })
const workflow = (a: Input) => '/workflows/' + part(a, 'workflow_id')
export const tools: Tool[] = [
  tool('create_draft', 'Create an inert workflow draft. No actions run.', 'POST', () => '/workflows', { input: object, idempotency_key: string }, ['input'], a => a.input),
  tool('update_draft', 'Save a workflow draft without publishing or sending.', 'POST', a => workflow(a) + '/draft', { workflow_id: string, input: object, idempotency_key: string }, ['workflow_id', 'input'], a => a.input),
  tool('validate_draft', 'Validate the saved draft without execution.', 'POST', a => workflow(a) + '/validate', { workflow_id: string }, ['workflow_id'], () => ({})),
  tool('publish_workflow', 'Publish the reviewed draft using native owner authority and existing cost checks.', 'POST', a => workflow(a) + '/publish', { workflow_id: string, input: object, idempotency_key: string }, ['workflow_id'], a => a.input ?? {}),
  tool('get_workflow', 'Read workflow progress, draft and versions.', 'GET', workflow, { workflow_id: string }, ['workflow_id']),
  tool('list_workflows', 'Find workflows by name or folder.', 'GET', a => '/workflows?' + new URLSearchParams(Object.entries(a).map(([k, v]) => [k, String(v)])), { q: string, folder: string }),
  tool('list_runs', 'Read a page of workflow runs. Pass next as before for the next page.', 'GET', a => '/workflow-runs?' + new URLSearchParams(Object.entries(a).map(([k, v]) => [k, String(v)])), { workflow: string, before: string, limit: { type: 'integer', minimum: 1, maximum: 100 }, status: string }),
  tool('get_run', 'Inspect an existing workflow run with the caller’s authority.', 'GET', a => '/workflow-runs/' + part(a, 'run_id'), { run_id: string }, ['run_id']),
  tool('list_connections', 'Read connection metadata, never credentials.', 'GET', () => '/connections'),
  tool('start_task', 'Start granted work with a separate execution credential; normal grant limits and exact approval apply.', 'POST', () => '/agent-tasks', { input: object, idempotency_key: string }, ['input'], a => a.input),
  tool('get_task', 'Read progress for this execution credential’s task.', 'GET', a => '/agent-tasks/' + part(a, 'run_id'), { run_id: string }, ['run_id']),
]

export function validArguments(tool: Tool, input: unknown): input is Input {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const a = input as Input, schema = tool.inputSchema
  if (schema.required.some(key => !(key in a))) return false
  return Object.entries(a).every(([key, value]) => {
    const spec = schema.properties[key] as { type: string; minimum?: number; maximum?: number } | undefined
    if (!spec) return false
    if (spec.type === 'string') return typeof value === 'string' && value.length > 0
    if (spec.type === 'integer') return typeof value === 'number' && Number.isInteger(value) && value >= (spec.minimum ?? -Infinity) && value <= (spec.maximum ?? Infinity)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  })
}
