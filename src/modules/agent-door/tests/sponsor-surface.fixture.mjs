const tool = (name, readOnly, classes, extra = {}) => ({ name: `synthetic.${name}`, scope: name === 'events.list' ? 'events:read' : readOnly ? 'records:read' : 'records:write', readOnly, classes, clauses: ['BASE-AGENT-005'], ...extra });
const step = (id, name, args, classes) => ({ id, tool: `synthetic.${name}`, args, expect: classes.map(item => typeof item === 'string' ? { class: item } : item) });
const access = direction => [{ class: 'access', facts: { measure: 1, direction } }];

export function sponsorSurface(teammateId = 'native-teammate') {
 return {
  schema: 'rer-agent-surface/1', seed: 'synthetic', specialist: 'operations',
  tools: [
   tool('records.list', true, ['standard'], { clauses: ['BASE-AGENT-002'] }), tool('records.write', false, ['standard'], { clauses: ['BASE-AGENT-002'] }),
   tool('records.erase', false, ['destructive'], { clauses: ['BASE-AGENT-006'] }), tool('records.send', false, ['external', 'sensitive'], { clauses: ['BASE-AGENT-006'] }),
   tool('access.change', false, ['access'], { clauses: ['BASE-AGENT-006'] }), tool('events.list', true, ['standard'], { clauses: ['BASE-AGENT-010'] }),
   tool('records.access', false, ['access'], { sponsorEscalation: false }),
   tool('access.teammate', false, ['access'], { sponsorEscalation: false }),
   tool('access.snapshot', true, ['standard']),
  ],
  notTools: [], resources: ['synthetic://record/{id}'],
  witness: { tool: 'synthetic.access.snapshot', args: {} },
  escalations: [{ id: 'widen-sponsor', tool: 'synthetic.access.change', args: { id: { $sponsor: 'id' } } }],
  journey: [
   step('snapshot', 'access.snapshot', {}, ['standard']),
   { ...step('write', 'records.write', { id: 'native-access-record', value: 'Native access conformance' }, ['standard']), resource: { uriTemplate: 'synthetic://record/{id}', state: { id: 'native-access-record', value: 'Native access conformance' } } },
   step('share-record', 'records.access', { id: { $from: 'write', pointer: '/id' }, visibility: 'shared' }, access('widens')),
   step('restrict-record', 'records.access', { id: { $from: 'write', pointer: '/id' }, visibility: 'internal' }, access('narrows')),
   step('promote-teammate', 'access.teammate', { id: teammateId, role: 'admin' }, access('widens')),
   step('demote-teammate', 'access.teammate', { id: teammateId, role: 'member' }, access('narrows')),
   step('grant-person', 'access.change', { id: teammateId }, access('widens')),
   step('reduce-person', 'access.teammate', { id: teammateId, role: 'member' }, access('narrows')),
   step('send', 'records.send', { id: { $from: 'write', pointer: '/id' } }, ['external', 'sensitive']),
   step('erase', 'records.erase', { id: { $from: 'write', pointer: '/id' } }, ['destructive']),
   step('list', 'records.list', {}, ['standard']), step('events', 'events.list', { limit: 200 }, ['standard']),
  ],
 };
}
