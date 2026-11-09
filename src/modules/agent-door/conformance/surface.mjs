import { offers, capabilitySet } from '../capabilities.mjs';
import { scopedSurface } from './subset.mjs';
import { recordOnlyAuthority } from './authority.mjs';
import { narrowingContract, narrowingTargets } from './narrowing.mjs';
import { validToolName } from './tool-name.mjs';

export const AGENT_CLASSES = Object.freeze(['standard', 'external', 'money', 'commitment', 'accounts', 'gated', 'access', 'security', 'destructive', 'sensitive', 'live']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasClause = (contract, clause) => typeof clause === 'string' && contract.split(/[^A-Za-z0-9_.-]+/).includes(clause);
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Validate the edition's static declaration without loading application code. */
export function validateAgentSurface(surface, { contract } = {}) {
 let set;
 try { set = capabilitySet(surface?.capabilities); surface = scopedSurface(surface); }
 catch (error) { return { ok: false, points: [{ id: 'BASE-AGENT-subset.declaration', ok: false, detail: error.message }] }; }
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
  add(`${label}.name`, validToolName(name, surface.seed) && !tools.has(name), `Malformed, duplicate or foreign-seed tool ${JSON.stringify(name)}.`);
  add(`${label}.scope`, text(tool?.scope), `${label} must declare its scope.`);
  add(`${label}.readOnly`, typeof tool?.readOnly === 'boolean', `${label} must declare readOnly.`);
  add(`${label}.classes`, Array.isArray(tool?.classes) && tool.classes.length > 0 && new Set(tool.classes).size === tool.classes.length && tool.classes.every(cls => AGENT_CLASSES.includes(cls)), `${label} has an empty, duplicate or uncatalogued class: ${JSON.stringify(tool?.classes)}.`);
  if (tool?.sponsorEscalation !== undefined) escalation(`${label}.sponsor-escalation`, typeof tool.sponsorEscalation === 'boolean' && Array.isArray(tool.classes) && tool.classes.some(cls => ['access', 'security'].includes(cls)), `${label} sponsorEscalation must be a boolean on an access or security tool.`);
  if (tool?.authority === 'none') escalation(`${label}.authority-none`, recordOnlyAuthority(tool), `${label} authority:none requires a closed record-only schema and a justified record effect, with no authority-bearing fields.`);
  const clauses = Array.isArray(tool?.clauses) ? tool.clauses : [];
  add(`${label}.clauses`, clauses.length > 0 && clauses.every(text), `${label} must name its contract clauses.`);
  if (contract !== undefined) for (const clause of clauses) add(`${label}.clause.${clause}`, hasClause(contract, clause), `${label} names clause ${clause}, absent from CONTRACT.md.`);
  if (tool?.proof !== undefined || tool?.proofKind !== undefined) add(`${label}.proof`, tool.proof === 'native' && typeof tool.proofKind === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(tool.proofKind), `${label} must declare proof native and its named proofKind.`);
  if (tool?.widens !== undefined || tool?.narrowing !== undefined) escalation(`${label}.narrowing-contract`, tool.widens === false && tool.readOnly === false && tool.classes?.some(cls => ['access', 'security'].includes(cls)) && narrowingContract(tool), `${label} narrowing requires revoke/narrow and a closed target-only string schema.`);
  tools.set(name, tool); coverage.set(name, new Set());
 }
 for (const [i, item] of (Array.isArray(surface.notTools) ? surface.notTools : []).entries()) {
  add(`notTools.${i}`, object(item) && ['device', 'screen', 'connector', 'import-door', 'installation'].includes(item.reason) && Array.isArray(item.clauses) && item.clauses.length > 0 && item.clauses.every(text), `notTools[${i}] must name clauses and a concrete reason other than risk.`);
  if (contract !== undefined && Array.isArray(item?.clauses)) for (const clause of item.clauses) add(`notTools.${i}.${clause}`, hasClause(contract, clause), `notTools[${i}] names clause ${clause}, absent from CONTRACT.md.`);
 }
 const references = (value, visit) => {
  if (Array.isArray(value)) value.forEach(item => references(item, visit));
  else if (object(value)) { if ('$from' in value || '$sponsor' in value || '$fixture' in value) visit(value); else Object.values(value).forEach(item => references(item, visit)); }
 };
 const checkReferences = (value, label, available, addPoint = add) => references(value, ref => {
  if ('$sponsor' in ref) addPoint(`${label}.sponsor`, Object.keys(ref).length === 1 && ['id', 'email'].includes(ref.$sponsor), `${label} must reference the sponsor as {$sponsor:'id'} or {$sponsor:'email'}.`);
  else if ('$fixture' in ref) addPoint(`${label}.fixture`, text(surface.verification?.fixtures?.module) && text(ref.$fixture) && Object.keys(ref).sort().join(',') === '$fixture,pointer' && typeof ref.pointer === 'string' && (ref.pointer === '' || ref.pointer.startsWith('/')), `${label} requires verification.fixtures and a named fixture with a JSON pointer.`);
  else addPoint(`${label}.ref.${ref.$from}`, available.has(ref.$from) && typeof ref.pointer === 'string' && (ref.pointer === '' || ref.pointer.startsWith('/')), `${label} references ${ref.$from} before its structuredContent is available, or has an invalid JSON pointer.`);
 });
 for (const [i, step] of (Array.isArray(surface.journey) ? surface.journey : []).entries()) {
  const id = text(step?.id) ? step.id : `journey[${i}]`, tool = tools.get(step?.tool);
  add(`journey.${id}`, object(step) && text(step.id) && !steps.has(step.id) && Boolean(tool) && object(step.args) && Array.isArray(step.expect) && step.expect.length > 0, `Invalid or duplicate journey step ${id}, tool ${JSON.stringify(step?.tool)}.`);
  const expect = Array.isArray(step?.expect) ? step.expect : [];
  add(`journey.${id}.classes`, new Set(expect.map(item => item?.class)).size === expect.length && expect.every(item => object(item) && Array.isArray(tool?.classes) && tool.classes.includes(item.class) && (item.facts === undefined || object(item.facts))), `${id} expects duplicate, undeclared or malformed classes.`);
  if (step?.client !== undefined) add(`journey.${id}.client`, text(step.client) && text(surface.verification?.fixtures?.module), `${id} requires a named native client and verification.fixtures.`);
  for (const item of expect) coverage.get(step?.tool)?.add(item?.class);
  checkReferences(step?.args, `journey.${id}`, steps);
  if (step?.resource !== undefined && offers(surface.capabilities, 'resources')) {
   const fixture = step.resource;
   const resourcePoint = (suffix, ok, detail) => points.push({ id: `BASE-AGENT-003.4.fixture.${id}.${suffix}`, ok: Boolean(ok), ...(!ok ? { detail } : {}) });
   resourcePoint('state', tool?.readOnly === false && object(fixture) && Object.keys(fixture).sort().join(',') === 'state,uriTemplate' && surface.resources?.includes(fixture.uriTemplate) && object(fixture.state) && Object.keys(fixture.state).length > 0, `${id}.resource must declare a native URI template and nonempty expected written state on a mutating tool.`);
   checkReferences(fixture?.state, `journey.${id}.resource`, new Set([...steps, id]), resourcePoint);
  }
  if (step?.target !== undefined) {
   const target = step.target;
   add(`journey.${id}.target`, object(target) && Object.keys(target).sort().join(',') === 'id,kind' && text(target.kind) && (text(target.id) || object(target.id) && ('$from' in target.id || '$sponsor' in target.id || '$fixture' in target.id)), `${id}.target must contain only a nonempty kind and an id string or journey reference.`);
   checkReferences(target, `journey.${id}.target`, steps);
  }
  if (step?.inject !== undefined) add(`journey.${id}.inject`, object(step.inject), `${id}.inject must be an object of additional arguments.`);
  checkReferences(step?.inject, `journey.${id}.inject`, steps);
  steps.add(step?.id);
 }
 const escalationIds = new Set(), escalationTools = new Set();
 for (const [i, step] of (Array.isArray(surface.escalations) ? surface.escalations : []).entries()) {
  const id = text(step?.id) ? step.id : `escalations[${i}]`, tool = tools.get(step?.tool);
  escalation(id, object(step) && text(step.id) && !escalationIds.has(step.id) && Boolean(tool) && object(step.args), `Invalid or duplicate escalation ${id}, tool ${JSON.stringify(step?.tool)}.`);
  escalation(`${id}.authority`, Array.isArray(tool?.classes) && tool.classes.some(cls => ['access', 'security'].includes(cls)) && tool.widens !== false && tool.sponsorEscalation !== false, `${id} must exercise a tool declared capable of widening its sponsor's authority.`);
  checkReferences(step?.args, `escalations.${id}`, steps, escalation);
  escalationIds.add(step?.id); escalationTools.add(step?.tool);
 }
 const narrowingTools = new Set();
 for (const [i, fixture] of (Array.isArray(surface.narrowings) ? surface.narrowings : []).entries()) {
  const tool = tools.get(fixture?.tool), witness = fixture?.witness;
  const targets = narrowingTargets(tool);
  escalation(`narrowing.${i}`, tool?.widens === false && !narrowingTools.has(fixture.tool) && steps.has(fixture.step) && surface.journey.some(step => step.id === fixture.step && step.tool === fixture.tool) && tools.get(witness?.tool)?.readOnly === true && object(witness?.args) && targets.length > 0 && targets.every(target => Object.hasOwn(witness.args, target)) && typeof witness?.pointer === 'string' && (witness.pointer === '' || witness.pointer.startsWith('/')), 'Narrowing fixture must name its journey step and a native grant-set witness with every target identifier.');
  checkReferences(witness?.args, `narrowing.${i}.witness`, steps, escalation);
  narrowingTools.add(fixture?.tool);
 }
 for (const [name, tool] of tools) if (Array.isArray(tool?.classes) && tool.classes.some(cls => ['access', 'security'].includes(cls))) escalation(`${name}.coverage`, tool.authority === 'none' && recordOnlyAuthority(tool) || (tool.widens === false ? narrowingTools.has(name) : tool.sponsorEscalation === false || escalationTools.has(name)), `${name} has no ${tool.widens === false ? 'narrowing check' : 'sponsor escalation fixture'}.`);
 for (const [name, tool] of tools) for (const cls of Array.isArray(tool?.classes) ? tool.classes : []) add(`${name}.coverage.${cls}`, coverage.get(name).has(cls), `${name} has no journey fixture for declared class ${cls}.`);
 if (offers(surface.capabilities, 'events')) add('events', tools.has(`${surface.seed}.events.list`), `Declare built-in ${surface.seed}.events.list in the Agent surface.`);
 if (set.mode === 'declared' && offers(surface.capabilities, 'resources')) add('resources.offered', surface.resources.length > 0, 'Declared resources must offer at least one resource template.');
 if (offers(surface.capabilities, 'resources') && surface.resources?.length && [...tools.values()].some(tool => tool.readOnly === false)) {
  const ok = surface.journey?.some(step => tools.get(step.tool)?.readOnly === false && step.resource !== undefined);
  points.push({ id: 'BASE-AGENT-003.4.fixture', ok: Boolean(ok), ...(!ok ? { detail: 'A writable door with resources must declare a record-writing journey resource fixture and its expected written state.' } : {}) });
 }
 add('witness', object(surface.witness) && tools.get(surface.witness.tool)?.readOnly === true && object(surface.witness.args), 'witness must name a declared readOnly tool and arguments.');
 checkReferences(surface.witness?.args, 'witness', new Set());
 return { ok: points.every(point => point.ok), points };
}
