import {CATALOGUE,classIds,classDefinition,isClass,type ClassId} from './catalogue.ts'
export const SCHEMA='rer-agent-policy/1'
export type Disposition='autonomous'|'review'|'approval'|'blocked'
export type ApproverRef='sponsor'|'role:owner'|'role:editor'|`person:${string}`
export type Threshold=number|{amount:number;currency:string}
export interface Rule {
 id:string; class:ClassId|'*'; do:Disposition; seed?:string; specialist?:string; agent?:string
 counterparty?:'internal'|'known'|'new'|'public'; direction?:'widens'|'narrows'
 max?:Threshold; max_per_day?:Threshold; approver?:ApproverRef[]; wait?:string
}
export interface SpendCap {seed:string;specialist:string;agent?:string;microusd_per_day:number}
export interface PolicyDocument {
 schema:typeof SCHEMA; catalogue:typeof CATALOGUE; rules:Rule[]; reviewers?:ApproverRef[]
 spend?:{none:true}|{caps:SpendCap[]}
}
export const scopeFields=['seed','specialist','agent','counterparty','direction','max','max_per_day'] as const
export class DocumentInvalid extends Error {
 readonly code='policy_document_invalid'
 readonly path:string
 constructor(path:string){super(`Invalid policy document at ${path}`);this.path=path}
}
const invalid=(path:string):never=>{throw new DocumentInvalid(path)}
export function object(value:unknown,path:string):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid(path)
 return value as Record<string,unknown>
}
export function closed(value:Record<string,unknown>,keys:readonly string[],path:string) {
 for(const key of Object.keys(value))if(!keys.includes(key))invalid(`${path}.${key}`)
}
const identifier=(value:unknown,path:string)=>{
 if(typeof value!=='string'||!value.trim()||value.length>200||/[\x00-\x1f]/.test(value))invalid(path)
}
const natural=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0
export interface ValidationContext {members?:ReadonlyMap<string,string>;seeds?:readonly string[]}
export function approverRefs(value:unknown,path:string,context:ValidationContext):asserts value is ApproverRef[] {
 if(!Array.isArray(value)||!value.length||value.length>200)invalid(path)
 for(const [i,ref] of (value as unknown[]).entries()){
  if(typeof ref!=='string'||!(['sponsor','role:owner','role:editor'].includes(ref)||/^person:[^\s:]{1,200}$/.test(ref)))invalid(`${path}[${i}]`)
  if(typeof ref==='string'&&ref.startsWith('person:')&&context.members&&!['owner','editor'].includes(context.members.get(ref.slice(7))??''))invalid(`${path}[${i}]`)
 }
}
/** Fixed-length ISO durations: months and years cannot give a deterministic approval deadline. */
export function durationSeconds(value:unknown):number|null {
 if(typeof value!=='string')return null
 const m=/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value)
 if(!m||!m.slice(1).some(Boolean)||value.endsWith('T'))return null
 const seconds=Number(m[1]??0)*86400+Number(m[2]??0)*3600+Number(m[3]??0)*60+Number(m[4]??0)
 return Number.isSafeInteger(seconds)&&seconds>=3600&&seconds<=30*86400?seconds:null
}
function threshold(value:unknown,cls:Rule['class'],path:string) {
 const money=cls==='money'||cls==='commitment'
 if(typeof value==='number'){
  if(money||!natural(value))invalid(path)
  return
 }
 if(cls!=='*'&&!money)invalid(path)
 const item=object(value,path);closed(item,['amount','currency'],path)
 if(!natural(item.amount))invalid(path+'.amount')
 if(typeof item.currency!=='string'||!/^[A-Z]{3}$/.test(item.currency))invalid(path+'.currency')
}
/** Identical to delivery/contracts canonical(): sorted object keys, array order retained. */
export function canonical(value:unknown):string {
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`
 if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
 return JSON.stringify(value)
}
export async function document_sha256(document:PolicyDocument):Promise<string> {
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(document)))
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
}
export function validateDocument(value:unknown,context:ValidationContext={}):PolicyDocument {
 const doc=object(value,'$');closed(doc,['schema','catalogue','rules','reviewers','spend'],'$')
 if(doc.schema!==SCHEMA)invalid('$.schema')
 if(doc.catalogue!==CATALOGUE)invalid('$.catalogue')
 if(!Array.isArray(doc.rules)||doc.rules.length>200)invalid('$.rules')
 const ids=new Set<string>()
 for(const [i,raw] of (doc.rules as unknown[]).entries()){
  const path=`$.rules[${i}]`,rule=object(raw,path)
  closed(rule,['id','class','do',...scopeFields,'approver','wait'],path)
  if(typeof rule.id!=='string'||!/^[a-z0-9-]{1,32}$/.test(rule.id)||ids.has(rule.id))invalid(path+'.id')
  ids.add(rule.id as string)
  if(rule.class!=='*'&&!isClass(rule.class))invalid(path+'.class')
  if(typeof rule.do!=='string'||!['autonomous','review','approval','blocked'].includes(rule.do))invalid(path+'.do')
  for(const field of ['seed','specialist','agent'] as const)if(field in rule)identifier(rule[field],path+'.'+field)
  if(rule.seed!==undefined&&rule.seed!=='business'&&context.seeds&&!context.seeds.includes(rule.seed as string))invalid(path+'.seed')
  if('counterparty' in rule&&(!['*','external','money','commitment'].includes(String(rule.class))||(typeof rule.counterparty!=='string'||!['internal','known','new','public'].includes(rule.counterparty))))invalid(path+'.counterparty')
  if('direction' in rule&&(!['*','access'].includes(String(rule.class))||(typeof rule.direction!=='string'||!['widens','narrows'].includes(rule.direction))))invalid(path+'.direction')
  for(const field of ['max','max_per_day'] as const)if(field in rule)threshold(rule[field],rule.class as Rule['class'],path+'.'+field)
  if(rule.do==='approval'){
   approverRefs(rule.approver,path+'.approver',context)
   if(durationSeconds(rule.wait)===null)invalid(path+'.wait')
  }else for(const field of ['approver','wait'])if(field in rule)invalid(path+'.'+field)
 }
 if('reviewers' in doc&&(!Array.isArray(doc.reviewers)||doc.reviewers.length))approverRefs(doc.reviewers,'$.reviewers',context)
 if('spend' in doc){
  const spend=object(doc.spend,'$.spend')
  if('none' in spend){closed(spend,['none'],'$.spend');if(spend.none!==true)invalid('$.spend.none')}
  else {
   closed(spend,['caps'],'$.spend')
   if(!Array.isArray(spend.caps)||spend.caps.length>50)invalid('$.spend.caps')
   for(const [i,raw] of (spend.caps as unknown[]).entries()){
    const path=`$.spend.caps[${i}]`,cap=object(raw,path)
    closed(cap,['seed','specialist','agent','microusd_per_day'],path)
    identifier(cap.seed,path+'.seed');identifier(cap.specialist,path+'.specialist')
    if('agent' in cap)identifier(cap.agent,path+'.agent')
    if(cap.seed!=='*'&&cap.seed!=='business'&&context.seeds&&!context.seeds.includes(cap.seed as string))invalid(path+'.seed')
    if(!natural(cap.microusd_per_day))invalid(path+'.microusd_per_day')
   }
  }
 }
 if(new TextEncoder().encode(canonical(doc)).byteLength>32768)invalid('$')
 return doc as unknown as PolicyDocument
}
function resolvable(refs:ApproverRef[],context:ValidationContext):boolean {
 return !context.members||refs.every(ref=>!ref.startsWith('role:')||[...context.members!.values()].includes(ref.slice(5)))
}
export interface Problem {kind:'class'|'approver'|'wait'|'reviewers'|'spend';class?:ClassId;rule?:string}
export const answered=(document:PolicyDocument|null,cls:ClassId)=>!!document?.rules.some(rule=>(rule.class==='*'||rule.class===cls)&&scopeFields.every(field=>rule[field]===undefined))
export function completeness(document:PolicyDocument|null,inUse:readonly ClassId[]=classIds,context:ValidationContext={}):Problem[] {
 const problems:Problem[]=inUse.filter(cls=>!answered(document,cls)).map(cls=>({kind:'class',class:cls}))
 if(document)for(const rule of document.rules)if(rule.do==='approval'){
  try{approverRefs(rule.approver,'',context);if(!resolvable(rule.approver,context))throw Error()}catch{problems.push({kind:'approver',rule:rule.id})}
  if(durationSeconds(rule.wait)===null)problems.push({kind:'wait',rule:rule.id})
 }
 if(document?.rules.some(rule=>rule.do==='review')&&!document.reviewers?.length)problems.push({kind:'reviewers'})
 if(document?.reviewers?.length)try{approverRefs(document.reviewers,'',context);if(!resolvable(document.reviewers,context))throw Error()}catch{problems.push({kind:'reviewers'})}
 if(!document?.spend)problems.push({kind:'spend'})
 return problems
}
// Measures are declarations, never company-selected thresholds.
export const monetary=(cls:ClassId)=>['amount','value'].includes(classDefinition(cls).measure)
