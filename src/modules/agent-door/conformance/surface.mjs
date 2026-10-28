export const AGENT_CLASSES = Object.freeze(['standard', 'external', 'money', 'commitment', 'accounts', 'gated', 'access', 'security', 'destructive', 'sensitive', 'live']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasClause = (contract, clause) => typeof clause === 'string' && contract.split(/[^A-Za-z0-9_.-]+/).includes(clause);
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Validate the edition's static declaration without loading application code. */
export function validateAgentSurface(surface, { contract } = {}) {
 const points = [], add = (id, ok, detail) => points.push({ id: `BASE-AGENT-013.surface.${id}`, ok: Boolean(ok), ...(!ok ? { detail } : {}) });
 add('schema', object(surface) && surface.schema === 'rer-agent-surface/1', 'Agent surface must use schema rer-agent-surface/1.');
 if (!object(surface)) return { ok: false, points };
 add('seed', text(surface.seed) && /^[a-z][a-z0-9-]*$/.test(surface.seed), `Invalid seed ${JSON.stringify(surface.seed)}.`);
 add('specialist', text(surface.specialist), 'Agent surface must name its specialist.');
 add('tools', Array.isArray(surface.tools) && surface.tools.length > 0, 'Agent surface must declare its tools.');
 add('notTools', Array.isArray(surface.notTools), 'Agent surface must declare notTools.');
 add('resources', Array.isArray(surface.resources), 'Agent surface must declare resources.');
 for (const uri of Array.isArray(surface.resources) ? surface.resources : []) add(`resource.${String(uri)}`, text(uri), 'Resource template must be a URI string.');
 add('journey', Array.isArray(surface.journey) && surface.journey.length > 0, 'Agent surface must declare its journey.');
 const escalation = (id, ok, detail) => points.push({ id: `BASE-AGENT-005.surface.${id}`, ok: Boolean(ok), ...(!ok ? { detail } : {}) });
 escalation('escalations', surface.escalations === undefined || Array.isArray(surface.escalations), 'Agent surface must declare its escalations.');
 const tools = new Map(), steps = new Set(), coverage = new Map();
 for (const [i, tool] of (Array.isArray(surface.tools) ? surface.tools : []).entries()) {
  const name = tool?.name, label = text(name) ? name : `tools[${i}]`;
  add(`${label}.name`, text(name) && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(name) && name.split('.')[0] === surface.seed && !tools.has(name), `Malformed, duplicate or foreign-seed tool ${JSON.stringify(name)}.`);
  add(`${label}.scope`, text(tool?.scope), `${label} must declare its scope.`);
  add(`${label}.readOnly`, typeof tool?.readOnly === 'boolean', `${label} must declare readOnly.`);
  add(`${label}.classes`, Array.isArray(tool?.classes) && tool.classes.length > 0 && new Set(tool.classes).size === tool.classes.length && tool.classes.every(cls => AGENT_CLASSES.includes(cls)), `${label} has an empty, duplicate or uncatalogued class: ${JSON.stringify(tool?.classes)}.`);
  const clauses = Array.isArray(tool?.clauses) ? tool.clauses : [];
  add(`${label}.clauses`, clauses.length > 0 && clauses.every(text), `${label} must name its contract clauses.`);
  if (contract !== undefined) for (const clause of clauses) add(`${label}.clause.${clause}`, hasClause(contract, clause), `${label} names clause ${clause}, absent from CONTRACT.md.`);
  tools.set(name, tool); coverage.set(name, new Set());
 }
 for (const [i, item] of (Array.isArray(surface.notTools) ? surface.notTools : []).entries()) {
  add(`notTools.${i}`, object(item) && ['device', 'screen', 'connector', 'import-door', 'installation'].includes(item.reason) && Array.isArray(item.clauses) && item.clauses.length > 0 && item.clauses.every(text), `notTools[${i}] must name clauses and a concrete reason other than risk.`);
  if (contract !== undefined && Array.isArray(item?.clauses)) for (const clause of item.clauses) add(`notTools.${i}.${clause}`, hasClause(contract, clause), `notTools[${i}] names clause ${clause}, absent from CONTRACT.md.`);
 }
 const references = (value, visit) => {
  if (Array.isArray(value)) value.forEach(item => references(item, visit));
  else if (object(value)) { if ('$from' in value || '$sponsor' in value) visit(value); else Object.values(value).forEach(item => references(item, visit)); }
 };
 const checkReferences = (value, label, available, addPoint = add) => references(value, ref => {
  if ('$sponsor' in ref) addPoint(`${label}.sponsor`, Object.keys(ref).length === 1 && ['id', 'email'].includes(ref.$sponsor), `${label} must reference the sponsor as {$sponsor:'id'} or {$sponsor:'email'}.`);
  else addPoint(`${label}.ref.${ref.$from}`, available.has(ref.$from) && typeof ref.pointer === 'string' && (ref.pointer === '' || ref.pointer.startsWith('/')), `${label} references ${ref.$from} before its structuredContent is available, or has an invalid JSON pointer.`);
 });
 for (const [i, step] of (Array.isArray(surface.journey) ? surface.journey : []).entries()) {
  const id = text(step?.id) ? step.id : `journey[${i}]`, tool = tools.get(step?.tool);
  add(`journey.${id}`, object(step) && text(step.id) && !steps.has(step.id) && Boolean(tool) && object(step.args) && Array.isArray(step.expect) && step.expect.length > 0, `Invalid or duplicate journey step ${id}, tool ${JSON.stringify(step?.tool)}.`);
  const expect = Array.isArray(step?.expect) ? step.expect : [];
  add(`journey.${id}.classes`, new Set(expect.map(item => item?.class)).size === expect.length && expect.every(item => object(item) && Array.isArray(tool?.classes) && tool.classes.includes(item.class) && (item.facts === undefined || object(item.facts))), `${id} expects duplicate, undeclared or malformed classes.`);
  for (const item of expect) coverage.get(step?.tool)?.add(item?.class);
  checkReferences(step?.args, `journey.${id}`, steps);
  if (step?.inject !== undefined) add(`journey.${id}.inject`, object(step.inject), `${id}.inject must be an object of additional arguments.`);
  checkReferences(step?.inject, `journey.${id}.inject`, steps);
  steps.add(step?.id);
 }
 const escalationIds = new Set(), escalationTools = new Set();
 for (const [i, step] of (Array.isArray(surface.escalations) ? surface.escalations : []).entries()) {
  const id = text(step?.id) ? step.id : `escalations[${i}]`, tool = tools.get(step?.tool);
  escalation(id, object(step) && text(step.id) && !escalationIds.has(step.id) && Boolean(tool) && object(step.args), `Invalid or duplicate escalation ${id}, tool ${JSON.stringify(step?.tool)}.`);
  escalation(`${id}.authority`, Array.isArray(tool?.classes) && tool.classes.some(cls => ['access', 'security'].includes(cls)), `${id} must exercise an access or security tool.`);
  checkReferences(step?.args, `escalations.${id}`, steps, escalation);
  escalationIds.add(step?.id); escalationTools.add(step?.tool);
 }
 for (const [name, tool] of tools) if (Array.isArray(tool?.classes) && tool.classes.some(cls => ['access', 'security'].includes(cls))) escalation(`${name}.coverage`, escalationTools.has(name), `${name} has no sponsor escalation fixture.`);
 for (const [name, tool] of tools) for (const cls of Array.isArray(tool?.classes) ? tool.classes : []) add(`${name}.coverage.${cls}`, coverage.get(name).has(cls), `${name} has no journey fixture for declared class ${cls}.`);
 add('events', tools.has(`${surface.seed}.events.list`), `Declare built-in ${surface.seed}.events.list in the Agent surface.`);
 add('witness', object(surface.witness) && tools.get(surface.witness.tool)?.readOnly === true && object(surface.witness.args), 'witness must name a declared readOnly tool and arguments.');
 checkReferences(surface.witness?.args, 'witness', new Set());
 return { ok: points.every(point => point.ok), points };
}
