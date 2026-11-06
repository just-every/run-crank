import type { agentUsage } from '../ops/agent-usage'
import { esc } from './document'

/** Reuses the Operations list and disclosure controls. */
export function agentUsageView(report: Awaited<ReturnType<typeof agentUsage>>) {
  return '<section class="panel" id="agent-usage"><h2>Native agent calls · ' + esc(report.month) + ' UTC</h2>' +
    '<p>' + esc(report.scope) + '. ' + esc(report.accounting) + '</p>' +
    '<p>' + esc(report.boundary) + '</p>' +
    '<p data-agent-totals>' + report.totals.request_attempts + ' request attempts · ' + report.totals.original_operations + ' original operations · ' + report.totals.replays + ' replays</p>' +
    '<ul class="list">' + (report.agents.map(agent => '<li class="history-item" data-agent-id="' + esc(agent.agent_id) + '">' +
      '<h3>' + esc(agent.name) + (agent.revoked ? ' · revoked' : '') + '</h3><p>' + esc(agent.agent_id) +
      (agent.specialist ? ' · ' + esc(agent.specialist) : '') + '</p><p>' +
      agent.request_attempts + ' request attempts · ' + agent.original_operations + ' original operations · ' + agent.replays + ' replays</p>' +
      '<p>Money moved: Not reported · Provider spend: Not reported</p>' +
      '<details><summary>Decisions and outcomes</summary><ul>' + agent.decisions.map(row => '<li>' +
        esc(row.decision) + ' · ' + esc(row.outcome) + ': ' + row.request_attempts + ' attempts (' + row.replays + ' replays)</li>').join('') +
      '</ul><h4>Decisions by class</h4><ul>' + (agent.classes.map(row => '<li>' +
        esc(row.class) + ' · ' + esc(row.decision) + ' · ' + esc(row.outcome) + ': ' +
        row.request_attempts + ' attempts (' + row.replays + ' replays)</li>').join('') || '<li>No classified calls.</li>') +
      '</ul></details></li>').join('') || '<li>No native agent calls in this UTC month.</li>') + '</ul></section>'
}
