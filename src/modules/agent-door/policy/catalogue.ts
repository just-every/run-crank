/** Platform-owned declarations. This file and document/decide have no platform dependencies. */
export const CATALOGUE='rer-agent-classes/1'
export const classes=[
 {id:'standard',when:'Changes internal work without carrying another risk.',measure:'items',facts:[],examples:['Save a cancellation suggestion for a person.']},
 {id:'external',when:'Sends information outside the company.',measure:'recipients',facts:['counterparty'],examples:['Send a message to a new counterparty.']},
 {id:'money',when:'Moves money.',measure:'amount',facts:['currency','counterparty'],examples:['Pay a known supplier.']},
 {id:'commitment',when:'Makes a commitment on the company’s behalf.',measure:'value',facts:['currency','counterparty'],examples:['Agree to a supplier contract.']},
 {id:'accounts',when:'Creates or changes an account with a provider.',measure:'calls',facts:['provider'],examples:['Create a provider account.']},
 {id:'gated',when:'Reaches a step a person must complete.',measure:'calls',facts:['provider','step'],examples:['Hand a provider verification step to a person.']},
 {id:'access',when:'Changes who can access something.',measure:'people',facts:['direction'],examples:['Give a colleague access; remove access.']},
 {id:'security',when:'Changes a security setting.',measure:'calls',facts:['setting'],examples:['Change a security control.']},
 {id:'destructive',when:'Deletes or destroys information or resources.',measure:'items',facts:[],examples:['Delete retained records.']},
 {id:'sensitive',when:'Reads or transfers sensitive information.',measure:'records',facts:['kind'],examples:['Transfer a W-9.']},
 {id:'live',when:'Changes a running service.',measure:'calls',facts:['service'],examples:['Pause a production monitor.']},
] as const
export type ClassId=typeof classes[number]['id']
export type Measure=typeof classes[number]['measure']
export const classIds:readonly ClassId[]=classes.map(entry=>entry.id)
export const isClass=(value:unknown):value is ClassId=>classIds.includes(value as ClassId)
export const classDefinition=(id:ClassId)=>classes.find(entry=>entry.id===id)!
export interface ClassFacts {
 measure:number; currency?:string; counterparty?:'internal'|'known'|'new'|'public'; direction?:'widens'|'narrows'
 provider?:string; step?:string; setting?:string; kind?:string; service?:string
}
