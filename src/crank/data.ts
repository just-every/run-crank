import { createPortability, readArchive, type Manifest, type Part, type Closing } from '@runeditrun/rer/internal/modules/portability/index.mjs'
import { createErasure, defineErasure } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import policy from './archive-policy.mjs'
import { authorize, requireOwner, requireWriteOrigin, guardedBatch } from './access'
import { body, type CrankEnv } from './model'
import { eraseWorkflowRun } from './workflow-erasure'

export const portability = (env: CrankEnv) => createPortability({ db:env.DB, policy })
const digest = async (s:string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('')

export async function dataApi(request:Request,env:CrankEnv):Promise<Response|null> {
  const path = new URL(request.url).pathname
  if (!path.startsWith('/api/crank/data/')) return null
  try {
    const actor = await authorize(request,env); requireOwner(actor)
    if(request.method !== 'GET') requireWriteOrigin(request,env,actor)
    const store = await portability(env)
    if (path === '/api/crank/data/export' && request.method === 'POST') {
      // Finish the incoming POST stream before returning a large download.
      // Discard its unused bytes without retaining or interpreting their values.
      await request.body?.pipeTo(new WritableStream({ write() {} }))
      const id = await store.exports.create(actor.id)
      try {
        let status = await store.exports.status(id)
        while (status.phase === 'building') status = await store.exports.advance(id,{maxParts:10})
        const reader = (await store.exports.download(id)).getReader(), chunks:Uint8Array[]=[]
        let length=0
        for (;;) {
          const part=await reader.read();if(part.done)break
          length+=part.value.length
          if(length>8*1024*1024) {await reader.cancel();await store.exports.abort(id);return Response.json({error:'Use rer export for archives larger than 8 MiB.'},{status:413})}
          chunks.push(part.value)
        }
        const bytes=new Uint8Array(length);let offset=0
        for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
        await store.exports.abort(id)
        return new Response(bytes,{headers:{'content-type':'application/x-ndjson','content-disposition':'attachment; filename="crank.rer"','cache-control':'no-store'}})
      } catch(error) { await store.exports.abort(id); throw error }
    }
    if (path === '/api/crank/data/restore' && request.method === 'POST') {
      const value = await body(request, 8 * 1024 * 1024)
      if (value.confirm !== 'RESTORE' || typeof value.archive !== 'string') return Response.json({error:'Confirm RESTORE and supply an archive.'},{status:400})
      const rows: (Manifest|Part|Closing)[] = []
      for await (const row of readArchive(new Response(value.archive).body!)) rows.push(row)
      const manifest = rows[0] as Manifest, closing = rows.at(-1) as Closing
      if (manifest?.kind !== 'manifest' || closing?.kind !== 'closing') throw new Error('Incomplete archive')
      let laterJournal
      if (typeof value.journal === 'string' && value.journal) {
        let later:Manifest|undefined
        for await (const row of readArchive(new Response(value.journal).body!)) if(row.kind==='manifest') later=row
        if (!later) throw new Error('Invalid later journal archive')
        laterJournal = {sourceIdentity:later.sourceIdentity,epoch:later.epoch,journal:later.journal}
      }
      const id = await store.imports.create(manifest,actor.id)
      try {
        for (const part of rows.slice(1,-1) as Part[]) await store.imports.uploadPart(id,part.index,part)
        const status = await store.imports.finalize(id,{archiveHash:closing.archiveHash,contentHash:closing.contentHash,laterJournal})
        return Response.json(status,{headers:{'cache-control':'no-store'}})
      } catch(error) { await store.imports.abort(id); throw error }
    }
    if (path === '/api/crank/data/erase' && request.method === 'POST') {
      const value = await body(request)
      if (value.workflow_run_id !== undefined) {
        if (value.confirm !== 'ERASE' || typeof value.workflow_run_id !== 'string' || !value.workflow_run_id || value.run_id !== undefined) return Response.json({error:'Confirm ERASE and select one workflow run.'},{status:400})
        return Response.json(await eraseWorkflowRun(env,actor,store,value.workflow_run_id),{headers:{'cache-control':'no-store'}})
      }
      if (value.confirm !== 'ERASE' || typeof value.run_id !== 'string') return Response.json({error:'Confirm ERASE and select a run.'},{status:400})
      const row = await env.DB.prepare('SELECT r.*,f.status AS flow_status FROM crank_runs r JOIN crank_flows f ON f.id=r.flow_id WHERE r.id=?').bind(value.run_id).first<{id:string;flow_id:string;event_id:string;state:string;flow_status:string}>()
      if (!row) return Response.json({error:'Run not found.'},{status:404})
      if (row.flow_status !== 'draft' || !['succeeded','failed','rejected'].includes(row.state)) return Response.json({error:'Pause the flow and finish or reject this run before erasing it.'},{status:409})
      const marker = await digest(row.event_id)
      const service = createErasure({db:env.DB,portability:store,declarations:[defineErasure({
        entity:'run',root:{table:'crank_runs'},
        edges:[{table:'crank_approvals',from:'crank_runs',on:{run_id:'id'}},{table:'crank_attempts',from:'crank_runs',on:{run_id:'id'}}],
        retain:[{table:'crank_erased_events',reason:'An opaque event digest blocks redelivery of the erased event. The receiving app owns its existing effect.'}],
        beforeStatements:async()=>[
          env.DB.prepare("INSERT INTO crank_authority_guards(id,ok) SELECT 'erase:'||?,CASE WHEN EXISTS(SELECT 1 FROM crank_runs r JOIN crank_flows f ON f.id=r.flow_id WHERE r.id=? AND r.state IN ('succeeded','failed','rejected') AND f.status='draft') THEN 1 ELSE 0 END").bind(row.id,row.id),
          env.DB.prepare('INSERT OR IGNORE INTO crank_erased_events(flow_id,event_digest) VALUES(?,?)').bind(row.flow_id,marker),
          env.DB.prepare("DELETE FROM crank_authority_guards WHERE id='erase:'||?").bind(row.id),
        ],
      })]})
      const prepared = await service.nativeStatements('run',{id:row.id})
      await guardedBatch(env,actor,'owner',prepared.statements.map(s=>env.DB.prepare(s.sql).bind(...s.params)))
      const receipt = await service.deleteBlobs(prepared.operationId)
      return Response.json(receipt,{headers:{'cache-control':'no-store'}})
    }
    return Response.json({error:'Not found'},{status:404})
  } catch(error:any) {
    return Response.json({error:error.code || (error.status ? error.message : 'Data operation refused. Check the archive and destination.')},{status:/^(erasure_epoch|erased_row)/.test(error.code || '') ? 409 : error.status || 409,headers:{'cache-control':'no-store'}})
  }
}
