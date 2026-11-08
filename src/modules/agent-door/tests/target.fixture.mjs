import { sponsorSurface } from './sponsor-surface.fixture.mjs';

export function targetSurface() {
 const surface = sponsorSurface();
 const extra = new Set(['synthetic.records.access', 'synthetic.access.teammate', 'synthetic.access.snapshot']);
 surface.tools = surface.tools.filter(tool => !extra.has(tool.name));
 surface.journey = surface.journey.filter(step => !extra.has(step.tool));
 surface.witness = { tool: 'synthetic.records.list', args: {} };
 for (const step of surface.journey) if (['write', 'send', 'erase'].includes(step.id)) step.target = { kind: 'record', id: 'redacted:native-access-record' };
 return surface;
}
