import { canonicalJson } from '../modules/import-kit/src/provenance/identity.ts'
import type { D1Sql, D1TargetAdapter } from '../modules/import-kit/src/d1/types.ts'
import type { TargetRow } from '../modules/import-kit/src/types.ts'
import { validateGraph } from './engine/graph'
const sql=(sql:string,...params:unknown[]):D1Sql=>({sql,params})
function value(row:TargetRow) {
  const v=row.value as any
  if(!v||typeof v.name!=='string'||typeof v.created_by!=='string'||v.status!=='draft')throw Error('IMPORT_WORKFLOW_MUST_BE_DRAFT')
  validateGraph(v.graph)
  return v
}
function native(row:Record<string,any>):TargetRow {
  return {destination:'crank-flows',targetKind:'workflow',targetId:row.id,revision:row.kit_revision,value:{name:row.name,created_by:row.created_by,status:row.status,graph:JSON.parse(row.draft_json)}}
}
/** Native drafts only: no published version, connection binding, webhook or execution authority. */
export const importWorkflowTargets:D1TargetAdapter={
  async read(db,destination,kind,id){
    const row=await db.prepare('SELECT w.*,s.kit_revision FROM crank_workflows w LEFT JOIN crank_import_workflow_state s ON s.workflow_id=w.id WHERE w.id=?').bind(id).first()
    if(!row)return undefined
    if(row.kit_revision===null)throw Error('IMPORT_TARGET_COLLISION')
    return native(row)
  },
  matches(row,destination,kind,id){
    if(!row)return sql('NOT EXISTS(SELECT 1 FROM crank_workflows WHERE id=?) AND NOT EXISTS(SELECT 1 FROM crank_import_workflow_state WHERE workflow_id=?)',id,id)
    const v=value(row)
    return sql(`EXISTS(SELECT 1 FROM crank_workflows w JOIN crank_import_workflow_state s ON s.workflow_id=w.id
      WHERE w.id=? AND s.kit_revision=? AND w.name=? AND w.draft_json=? AND w.created_by=? AND w.owner_id=?
      AND w.status='draft' AND w.published_version_id IS NULL AND w.created_at=s.created_at AND w.draft_updated_at=s.created_at
      AND w.description='' AND w.folder='' AND w.settings_json='{}' AND w.environment='production' AND w.data_class='none')
      AND NOT EXISTS(SELECT 1 FROM crank_wf_runs WHERE workflow_id=?)
      AND NOT EXISTS(SELECT 1 FROM crank_workflow_versions WHERE workflow_id=?)
      AND NOT EXISTS(SELECT 1 FROM crank_workflow_drafts WHERE workflow_id=?)
      AND NOT EXISTS(SELECT 1 FROM crank_hooks WHERE workflow_id=?)`,id,row.revision,v.name,canonicalJson(v.graph),v.created_by,v.created_by,id,id,id,id)
  },
  matchesCount(count){return sql('(SELECT COUNT(*) FROM crank_import_workflow_state)=?',count)},
  write(row){const v=value(row);return [
    sql("INSERT INTO crank_import_workflow_state(workflow_id,kit_revision,created_at) VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(workflow_id) DO UPDATE SET kit_revision=excluded.kit_revision",row.targetId,row.revision),
    sql(`INSERT INTO crank_workflows(id,name,owner_id,draft_json,draft_updated_at,status,created_by,created_at)
      SELECT ?,?,?,?,created_at,'draft',?,created_at FROM crank_import_workflow_state WHERE workflow_id=?
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,draft_json=excluded.draft_json,draft_updated_at=excluded.draft_updated_at`,row.targetId,v.name,v.created_by,canonicalJson(v.graph),v.created_by,row.targetId),
  ]},
  remove(destination,kind,id){return [sql('DELETE FROM crank_workflows WHERE id=?',id),sql('DELETE FROM crank_import_workflow_state WHERE workflow_id=?',id)]},
  async list(db){const {results}=await db.prepare('SELECT w.*,s.kit_revision FROM crank_workflows w JOIN crank_import_workflow_state s ON s.workflow_id=w.id ORDER BY w.id').all();return results.map(native)},
}
