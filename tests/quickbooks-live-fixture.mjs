import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sandboxAccessToken} from './quickbooks-sandbox-auth.mjs';

/** Actual sandbox calls only. Provider payload values and credentials are never logged. */
export async function quickbooksLiveFixture() {
 for(const name of ['QUICKBOOKS_CLIENT_ID','QUICKBOOKS_CLIENT_SECRET','QBO_REFRESH_TOKEN','QBO_REALM_ID'])assert.ok(process.env[name],`Inject ${name}`);
 const realm=process.env.QBO_REALM_ID;assert.match(realm,/^[0-9]{1,30}$/);const token=await sandboxAccessToken(),origin='https://sandbox-quickbooks.api.intuit.com',base=origin+'/v3/company/'+realm;
 function receipt(url,method,response,value){const records=['Invoice','Customer','Item'].flatMap(entity=>(value.QueryResponse?.[entity]??(value[entity]?[value[entity]]:[])).map(r=>({entity,Id:r.Id,SyncToken:r.SyncToken,DocNumber:r.DocNumber,CustomerRef:r.CustomerRef,TotalAmt:r.TotalAmt,CurrencyRef:r.CurrencyRef})));console.log(JSON.stringify({provider_receipt:true,method,path:url.pathname,request_id:url.searchParams.get('requestid'),intuit_tid:response.headers.get('intuit_tid'),http_status:response.status,records}))}
 async function api(path,body){const url=new URL(base+path);if(body!==undefined)url.searchParams.set('requestid',randomUUID());const method=body===undefined?'GET':'POST',response=await fetch(url,{method,redirect:'error',headers:{accept:'application/json','content-type':'application/json',authorization:'Bearer '+token},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(response.ok,`Sandbox HTTP ${response.status} at ${url.pathname}`);const value=await response.json();receipt(url,method,response,value);return value}
 async function query(entity,filter){const value=await api('/query?'+new URLSearchParams({query:`select * from ${entity} where ${filter} maxresults 100`}));const rows=value.QueryResponse?.[entity]??[];assert.ok(Array.isArray(rows)&&rows.length<100,'Complete sandbox query required');return rows}
 assert.equal((await api('/companyinfo/'+realm)).CompanyInfo.Country,'US');const accounts=await query('Account',"AccountType = 'Income' and Active = true");assert.ok(accounts.length);
 const name='synthetic-crank-'+randomUUID();const customer=(await api('/customer',{DisplayName:name,GivenName:'Synthetic',FamilyName:'Crank'})).Customer;
 const wrongCustomer=(await api('/customer',{DisplayName:name+' wrong',GivenName:'Synthetic',FamilyName:'Other'})).Customer;
 const item=(await api('/item',{Name:name,Type:'Service',IncomeAccountRef:{value:accounts[0].Id}})).Item;
 async function forward(request,{body}={}){const url=new URL(request.url),bytes=body??(!['GET','HEAD'].includes(request.method)?await request.text():undefined),response=await fetch(url,{method:request.method,redirect:'error',headers:{accept:'application/json','content-type':'application/json',authorization:'Bearer '+token},...(bytes===undefined?{}:{body:bytes})});const value=await response.json();receipt(url,request.method,response,value);return new Response(JSON.stringify(value),{status:response.status,headers:{'content-type':'application/json'}})}
 return {realm,token,customer,wrongCustomer,item,origin,base,api,query,forward};
}
