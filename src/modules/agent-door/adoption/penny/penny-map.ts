import type { AgentArtifactMap } from '../../index.ts'

// Penny cloud/sd-door-adopt-penny-1 plus the additive migration below.
// Every agent-door table and column is declared. ?1 is a JSON array of the native
// erasure plan's selected identifiers and personal literals (plan.literals), never caller SQL.
// Search decoded JSON string values (or a raw text column), never JSON keys
// or numbers. Short IDs preserve URI/version tokens; longer IDs and emails
// can occur in path segments. Inspect later hits after an embedded occurrence.
const strictTokenCharacter = "'[A-Za-z0-9_@.+/:-]'"
const separatorTokenCharacter = "'[A-Za-z0-9_@.+-]'"
const minimumSeparatorLength = 8
const textValue = 'CAST(subject.value AS TEXT)'
const tokenCharacter = `CASE WHEN length(${textValue})<${minimumSeparatorLength} AND instr(${textValue},'@')=0 THEN ${strictTokenCharacter} ELSE ${separatorTokenCharacter} END`
// A period separates sentences only when its outward neighbor cannot continue
// an identifier. Apply the same rule on both sides of every literal hit.
const boundary = (position: string, outward: number) => {
  const char = `substr(text,${position},1)`, next = `substr(text,(${position})+(${outward}),1)`
  return `(${char} NOT GLOB token OR (${char}='.' AND ${next} NOT GLOB token))`
}
const textMention = (column: string) => `EXISTS(
  WITH RECURSIVE hits(text,source,pos,token) AS (
    SELECT content.value,${textValue},instr(content.value,${textValue}),(${tokenCharacter})
    FROM json_tree(CASE WHEN json_valid(${column}) THEN ${column} ELSE json_quote(${column}) END) content
    WHERE content.type='text' AND instr(content.value,${textValue})>0
    UNION ALL
    SELECT text,source,pos+instr(substr(text,pos+1),source),token FROM hits
    WHERE pos>0 AND instr(substr(text,pos+1),source)>0
  )
  SELECT 1 FROM hits WHERE pos>0
    AND ${boundary('pos-1', -1)}
    AND ${boundary('pos+length(source)', 1)}
)`
const mentions = (table: string, columns: string[]) => "EXISTS(SELECT 1 FROM json_each(?1) subject WHERE subject.type='text' AND (" + columns.map(column => textMention(table + '.' + column)).join(' OR ') + '))'
const calls = mentions('agent_door_calls', ['key', 'outcome']), approvals = mentions('agent_door_approvals', ['saved', 'approvals', 'result']), reviews = mentions('agent_door_reviews', ['saved', 'marked_by']), audits = mentions('agent_door_audit', ['row', 'evidence'])
const decisions = "SELECT decision_id FROM agent_door_calls WHERE " + calls + " UNION SELECT json_extract(saved,'$.decision_id') FROM agent_door_approvals WHERE " + approvals + " UNION SELECT json_extract(saved,'$.decision_id') FROM agent_door_reviews WHERE " + reviews + " UNION SELECT id FROM agent_door_audit WHERE " + audits + " UNION SELECT door_operation_id FROM audit_entries WHERE entity_id IN (SELECT value FROM json_each(?1)) OR " + mentions('audit_entries', ['details_json'])
const match = (sql: string) => ({ sql, params: ['values'] })
export const pennyAgentArtifacts: AgentArtifactMap = { artifacts: [
  { table: 'agent_door_retired_refs', columns: ['digest','marker'], unrelated: 'Value-free suppression digests and erasure markers preserve retirement across restore.' },
  { table: 'agent_door_relay', columns: ['sequence','decision_id','business'], unrelated: 'Value-free decision ids and installation Business id only; projections are computed from the erasure-aware audit.' },
  { table: 'agent_door_state', columns: ['id','envelope','local_document','local_revision','local_paused','decision_lock','decision_until'], unrelated: 'Installation policy and admission leases; Penny customer subjects are not policy principals.' },
  { table: 'agent_door_agents', columns: ['id','name','specialist','sponsor','sponsor_name','revoked','window','requests','tombstone'], unrelated: 'Non-person agent identities and native operator sponsors; Penny customer subjects are not operators.' },
  { table: 'agent_door_calls', columns: ['agent','key','digest','decision_id','created_at','state','outcome','expires_at'], match: match('decision_id IN (' + decisions + ')') },
  // Resolve the same decision set once for the audit row's multiple links.
  { table: 'agent_door_audit', columns: ['sequence','id','at','agent','classes','row','evidence'], match: match(`rowid IN (WITH selected(decision_id) AS MATERIALIZED (${decisions}) SELECT rowid FROM agent_door_audit WHERE id IN (SELECT decision_id FROM selected) OR json_extract(row,'$.decision_id') IN (SELECT decision_id FROM selected))`) },
  { table: 'agent_door_approvals', columns: ['id','state','saved','approvals','result','version'], match: match('json_extract(saved,\'$.decision_id\') IN (' + decisions + ') OR ' + approvals) },
  { table: 'agent_door_reviews', columns: ['id','state','saved','marked_by','marked_at'], match: match('json_extract(saved,\'$.decision_id\') IN (' + decisions + ') OR ' + reviews) },
  { table: 'agent_door_events', columns: ['sequence','id','uri','event'], match: match(mentions('agent_door_events', ['uri','event']) + ' OR json_extract(event,\'$.decision_id\') IN (' + decisions + ')') },
  { table: 'agent_door_usage', columns: ['decision_id','at','seed','specialist','agent','classes'], match: match('decision_id IN (' + decisions + ')') },
  { table: 'agent_door_replay_aliases', columns: ['agent','alias','call_id','tombstone'], unrelated: 'Installation-private, value-free replay aliases; excluded from archives and exports.' },
] }

