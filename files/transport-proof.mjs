import {Miniflare} from '/workspace/run-crank/node_modules/miniflare/dist/src/index.js';
const original=Miniflare.prototype.dispatchFetch;
Miniflare.prototype.dispatchFetch=async function(input,init){
 try{return await original.call(this,input,init);}
 catch(error){
  let path='unknown';try{path=new URL(typeof input==='string'?input:input.url).pathname;}catch{}
  console.error('NATIVE_TRANSPORT_FAILURE',JSON.stringify({method:init?.method??'GET',path,name:error.name,message:error.message,cause:error.cause?{name:error.cause.name,code:error.cause.code,message:error.cause.message}:null}));
  throw error;
 }
};
