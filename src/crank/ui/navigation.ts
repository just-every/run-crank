import { esc } from './document'
import { icon } from './icons'

// Each screen title maps to the rail item it belongs to.
const SECTION: Record<string, string> = {
  'Run details': 'Runs', 'Workflow run': 'Runs', 'Import preview': 'Move in', 'Import refused': 'Move in', 'Credential created': 'Access', 'Workflow test': 'Flows',
}
export function navigation(title: string, owner: boolean, approvals: number, section?: string) {
  const current = section ?? SECTION[title] ?? title
  const links: [string, string, string][] = [
    ['Flows', '/app', 'flows'], ['Runs', '/app/runs', 'runs'], ['Connections', '/app/connections', 'connections'], ['Approvals', '/app/approvals', 'approvals'],
    ...(owner ? [['Move in', '/app/import', 'movein'], ['Access', '/app/access', 'access'], ['Data', '/app/data', 'data']] as [string, string, string][] : []),
    ['Account', '/auth/settings/identity', 'account'],
  ]
  return `<aside class="rail"><nav aria-label="Workspace">${links.map(([name, href, glyph]) => `<a href="${href}"${current === name ? ' aria-current="page"' : ''}>${icon(glyph)}<span>${esc(name)}</span>${name === 'Approvals' && approvals ? `<span class="count" aria-label="${approvals} waiting">${approvals > 99 ? '99+' : approvals}</span>` : ''}</a>`).join('')}</nav></aside>`
}
