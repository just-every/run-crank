import { createPortability, readArchive, type Manifest, type Part, type Closing } from '@runeditrun/rer/internal/modules/portability/index.mjs'
import policy from './archive-policy.mjs'
import { authorize, requireOwner, requireWriteOrigin, guardedBatch } from './access'
import { body, type CrankEnv } from './model'
import { eraseFlowRun, eraseWorkflowRun } from './workflow-erasure'
import { eraseSubject, previewSubject } from './subject-erasure'
import { eraseOperator } from './operator-erasure'
import { auditStatement } from './ops/audit'
import { attest, revokeAttestation, sensitiveData, setDataClass } from './ops/sensitive-data'
import { exportKeyFile, importKeyFile, rotateKey } from './ops/payload-keys'
import { operatorAuth } from '../auth.server'
import { DISCLOSURE, listHolds, placeHold, previewRetention, releaseHold, retentionPolicy, retentionScope, setRetention } from './ops/retention'

export const portability = (env: CrankEnv) => createPortability({ db:env.DB, policy })

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
        await guardedBatch(env,actor,'owner',[auditStatement(env,actor.id,'data.export','workspace','data',{bytes:length})])
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
        await guardedBatch(env,actor,'owner',[auditStatement(env,actor.id,'data.restore','workspace','data',{archive_hash:closing.archiveHash,normalized:(status.safetyChanges ?? []).map(({table,column,rows}:{table:string;column:string;rows:number})=>({table,column,rows}))})])
        return Response.json(status,{headers:{'cache-control':'no-store'}})
      } catch(error) { await store.imports.abort(id); throw error }
    }
    if (path === '/api/crank/data/erase' && request.method === 'POST') {
      const value = await body(request)
      if (value.workflow_run_id !== undefined) {
        if (value.confirm !== 'ERASE' || typeof value.workflow_run_id !== 'string' || !value.workflow_run_id || value.run_id !== undefined) return Response.json({error:'Confirm ERASE and select one workflow run.'},{status:400})
        return Response.json(await eraseWorkflowRun(env,actor,store,value.workflow_run_id),{headers:{'cache-control':'no-store'}})
      }
      if (value.operator_id !== undefined) {
        if (value.confirm !== 'ERASE' || typeof value.operator_id !== 'string' || !value.operator_id) return Response.json({error:'Confirm ERASE and select one deactivated person.'},{status:400})
        return Response.json(await eraseOperator(env,actor,value.operator_id),{headers:{'cache-control':'no-store'}})
      }
      if (value.subject !== undefined) {
        if (value.confirm !== 'ERASE' || typeof value.subject !== 'string' || typeof value.digest !== 'string') return Response.json({error:'Confirm ERASE with the subject and its preview digest.'},{status:400})
        return Response.json(await eraseSubject(env,actor,store,value.subject,value.digest),{headers:{'cache-control':'no-store'}})
      }
      if (value.confirm !== 'ERASE' || typeof value.run_id !== 'string') return Response.json({error:'Confirm ERASE and select a run.'},{status:400})
      return Response.json(await eraseFlowRun(env,actor,store,value.run_id),{headers:{'cache-control':'no-store'}})
    }
    if (path === '/api/crank/data/retention' && request.method === 'GET') {
      const policy = await retentionPolicy(env)
      return Response.json({ policy, disclosure: DISCLOSURE, holds: await listHolds(env), scope: await retentionScope(env, policy), sensitive: await sensitiveData(env) },{headers:{'cache-control':'no-store'}})
    }
    if (path === '/api/crank/data/retention/preview' && request.method === 'POST') return Response.json(await previewRetention(env,await body(request)),{headers:{'cache-control':'no-store'}})
    if (path === '/api/crank/data/retention' && request.method === 'POST') return Response.json(await setRetention(env,actor,await body(request)),{headers:{'cache-control':'no-store'}})
    if (path === '/api/crank/data/holds' && request.method === 'POST') return Response.json(await placeHold(env,actor,await body(request)),{status:201,headers:{'cache-control':'no-store'}})
    const release = /^\/api\/crank\/data\/holds\/([^/]+)\/release$/.exec(path)
    if (release && request.method === 'POST') return Response.json(await releaseHold(env,actor,decodeURIComponent(release[1])),{headers:{'cache-control':'no-store'}})
    if (path === '/api/crank/data/classes' && request.method === 'POST') { const value = await body(request); return Response.json(await setDataClass(env,actor,String(value.workflow_id ?? ''),value.data_class,value.identifier_fields),{headers:{'cache-control':'no-store'}}) }
    // DATA-003 key custody: rotate a class key; the key file leaves and enters only with a fresh step-up proof.
    if (path === '/api/crank/data/keys/rotate' && request.method === 'POST') return Response.json(await rotateKey(env,actor,await body(request)),{headers:{'cache-control':'no-store'}})
    if (path === '/api/crank/data/keys/export' && request.method === 'POST') {
      await operatorAuth(env).requireStepUp(request,'export')
      return Response.json(await exportKeyFile(env,actor,await body(request)),{headers:{'cache-control':'no-store','content-disposition':'attachment; filename="crank-keys.json"'}})
    }
    if (path === '/api/crank/data/keys/import' && request.method === 'POST') {
      await operatorAuth(env).requireStepUp(request,'credentials:mint')
      return Response.json(await importKeyFile(env,actor,await body(request,256*1024)),{headers:{'cache-control':'no-store'}})
    }
    if (path === '/api/crank/data/attestations' && request.method === 'POST') return Response.json(await attest(env,actor,await body(request)),{status:201,headers:{'cache-control':'no-store'}})
    const revoke = /^\/api\/crank\/data\/attestations\/([^/]+)\/revoke$/.exec(path)
    if (revoke && request.method === 'POST') return Response.json(await revokeAttestation(env,actor,decodeURIComponent(revoke[1])),{headers:{'cache-control':'no-store'}})
    if (path === '/api/crank/data/subject' && request.method === 'POST') {
      const value = await body(request)
      return Response.json(await previewSubject(env,value.subject),{headers:{'cache-control':'no-store'}})
    }
    return Response.json({error:'Not found'},{status:404})
  } catch(error:any) {
    return Response.json({error:error.code === 'staged_validation' ? 'staged_validation: Archive product records are inconsistent (a broken workflow graph, version digest or record reference). Nothing was restored.' : error.code || (error.status ? error.message : 'Data operation refused. Check the archive and destination.')},{status:/^(erasure_epoch|erased_row)/.test(error.code || '') ? 409 : error.status || 409,headers:{'cache-control':'no-store'}})
  }
}
