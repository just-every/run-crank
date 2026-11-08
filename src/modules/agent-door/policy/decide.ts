import {classIds,type ClassFacts,type ClassId} from './catalogue.ts'
import {answered,durationSeconds,monetary,scopeFields,type ApproverRef,type Disposition,type PolicyDocument,type Rule,type Threshold} from './document.ts'
export interface PolicyCall {seed:string;specialist:string|null;agent:string;classes:Array<{class:ClassId;facts:ClassFacts}>}
export interface Decision {
 result:Disposition|'unset';revision:number|null;classes:Array<{class:ClassId;rule:string|null;do:Disposition|'unset'}>
 deciding:{class:ClassId;rule:string}|null;approvers?:ApproverRef[];wait?:string;unset?:ClassId[]
}
const strictness={autonomous:0,review:1,approval:2,blocked:3,unset:4}
export function scopeMatches(rule:Rule,call:Pick<PolicyCall,'seed'|'specialist'|'agent'>,facts:ClassFacts):boolean {
 return (['seed','specialist','agent'] as const).every(key=>rule[key]===undefined||rule[key]===call[key])
  && (['counterparty','direction'] as const).every(key=>rule[key]===undefined||rule[key]===facts[key])
}
function within(max:Threshold,measure:number,cls:ClassId,facts:ClassFacts) {
 if(!Number.isSafeInteger(measure)||measure<0)return false
 return typeof max==='number'?!monetary(cls)&&measure<=max:monetary(cls)&&facts.currency===max.currency&&measure<=max.amount
}
export function decide(input:{document:PolicyDocument|null;revision:number|null;call:PolicyCall;usageToday:(rule:Rule,cls:ClassId)=>number}):Decision {
 const {document,revision,call,usageToday}=input
 const winners=new Map<ClassId,Rule>()
 const decisions:Decision['classes']=call.classes.map(({class:cls,facts})=>{
  // Narrowed rules refine an answered class; even a matching rule cannot supply its catch-all.
  if(!answered(document,cls))return {class:cls,rule:null,do:'unset'}
  const candidates=(document?.rules??[]).filter(rule=>(rule.class===cls||rule.class==='*')&&scopeMatches(rule,call,facts)
   &&(rule.max===undefined||within(rule.max,facts.measure,cls,facts))
   &&(rule.max_per_day===undefined||within(rule.max_per_day,usageToday(rule,cls)+facts.measure,cls,facts)))
  const named=candidates.filter(rule=>rule.class===cls),pool=named.length?named:candidates
  let winner:Rule|undefined,specificity=-1
  for(const rule of pool){
   const score=scopeFields.filter(field=>rule[field]!==undefined).length
   if(!winner||score>specificity||(score===specificity&&strictness[rule.do]>strictness[winner.do])){winner=rule;specificity=score}
  }
  if(winner)winners.set(cls,winner)
  return {class:cls,rule:winner?.id??null,do:winner?.do??'unset'}
 })
 const unset=decisions.filter(item=>item.do==='unset').map(item=>item.class)
 if(unset.length||!decisions.length)return {result:'unset',revision,classes:decisions,deciding:null,unset}
 const result=decisions.reduce<Disposition>((strict,item)=>strictness[item.do]>strictness[strict]?item.do as Disposition:strict,'autonomous')
 const decidingClass=classIds.find(cls=>winners.get(cls)?.do===result)!,deciding={class:decidingClass,rule:winners.get(decidingClass)!.id}
 if(result!=='approval')return {result,revision,classes:decisions,deciding}
 const approvals=classIds.map(cls=>winners.get(cls)).filter((rule):rule is Rule=>rule?.do==='approval')
 const approvers=[...new Set(approvals.flatMap(rule=>rule.approver!))]
 const shortest=approvals.reduce((a,b)=>durationSeconds(a.wait)!<=durationSeconds(b.wait)!?a:b)
 return {result,revision,classes:decisions,deciding,approvers,wait:shortest.wait!}
}
