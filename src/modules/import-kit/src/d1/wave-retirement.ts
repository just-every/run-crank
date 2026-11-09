import type { D1Database, D1ImportPerson, D1PlanCodec, D1Sql } from './types.ts';
import { targetIdentity } from './erasure-index.ts';
import { sql } from './database.ts';
import { doorLineage } from './retirement-door.ts';
import { canonicalJson, sha256 } from '../provenance/identity.ts';

/** Wave snapshots are indivisible custody. Retire their actual child journals
 * whole before ordinary erasure tries to rewrite an attachment-bearing entry.
 * The caller still deletes only the selected person's native data. Peer native
 * records remain; this is withdrawal, never successful Undo or reconciliation. */
export async function waveRetirementSeeds(db: D1Database, destination: string, person: D1ImportPerson, codec?: D1PlanCodec): Promise<{jobs:string[];roots:string[];tombstones:{installation:string;namespace:string;identity:string}[];guards:D1Sql[]}> {
  const empty={jobs:[],roots:[],tombstones:[],guards:[]};
  if (!person.target && !person.aliases?.length) return empty;
  if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ik_door_wave_children'").first()) {
    if (person.aliases?.length) throw new Error('IMPORT_WAVE_SCHEMA_REQUIRED');
    return empty;
  }
  if (!person.aliases?.length && !await db.prepare('SELECT 1 FROM ik_door_wave_roots WHERE destination=? LIMIT 1').bind(destination).first()) return empty;
  const lineage=await doorLineage(person,db,destination,codec);
  const tombstones=[...lineage.sources.map(source=>{
    const [installation,namespace,kind,id]=JSON.parse(source);
    return {installation,namespace,identity:sha256(canonicalJson([kind,id]))};
  }),...(person.aliases ?? []).map(a=>({installation:a.installationId,namespace:a.namespace,identity:sha256(canonicalJson([a.kind,a.sourceId]))}))];
  const scopes=JSON.stringify(tombstones);
  const selection=`WITH RECURSIVE affected(parent_id) AS (
    SELECT DISTINCT c.parent_id FROM ik_door_wave_children c JOIN ik_door_plans p ON p.id=c.plan_id
    JOIN ik_jobs j ON j.id=p.job_id OR j.operation_key='door:'||p.id JOIN ik_d1_plan_index i ON i.job_id=j.id
    WHERE j.destination=? AND i.target_identity=?
    UNION SELECT m.parent_id FROM ik_door_wave_members m JOIN ik_door_wave_roots r ON r.id=m.parent_id JOIN json_each(?) s
      ON r.installation_id=json_extract(s.value,'$.installation') AND r.namespace=json_extract(s.value,'$.namespace')
      AND m.identity=json_extract(s.value,'$.identity') WHERE r.destination=? AND m.type IN ('source','alias')
    UNION SELECT r.id FROM ik_door_wave_roots r JOIN affected a ON r.previous_id=a.parent_id JOIN ik_door_wave_roots parent ON parent.id=a.parent_id WHERE r.destination=? AND r.installation_id=parent.installation_id AND r.namespace=parent.namespace
    ) SELECT parent_id FROM affected`;
  const digest=person.target ? targetIdentity(destination,person.target.kind,person.target.id) : null;
  const parameters=[destination,digest,scopes,destination,destination];
  const roots=(await db.prepare(selection).bind(...parameters).all<{parent_id:string}>()).results.map(row=>row.parent_id);
  if (!roots.length) return {jobs:[],roots:[],tombstones,guards:[]};
  const rootJson=JSON.stringify(roots);
  const members=`SELECT j.id FROM ik_door_wave_children c JOIN ik_door_plans p ON p.id=c.plan_id
    JOIN ik_jobs j ON j.id=p.job_id OR j.operation_key='door:'||p.id WHERE j.destination=? AND c.parent_id IN (SELECT value FROM json_each(?))`;
  const jobs=(await db.prepare(members).bind(destination,rootJson).all<{id:string}>()).results.map(row=>row.id);
  return {jobs,roots,tombstones,guards:[
    ...lineage.fence,
    sql(`NOT EXISTS(SELECT 1 FROM (${selection}) WHERE parent_id NOT IN (SELECT value FROM json_each(?)))`,...parameters,rootJson),
    sql(`NOT EXISTS(SELECT 1 FROM (${members}) WHERE id NOT IN (SELECT value FROM json_each(?)))`,destination,rootJson,JSON.stringify(jobs)),
  ]};
}
