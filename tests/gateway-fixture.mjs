import assert from 'node:assert/strict';
import {createHash,createPrivateKey,randomBytes,sign} from 'node:crypto';
import {resolve} from 'node:path';

export async function freshGatewayOwner(h) {
  const request=await h.send('/auth/step-up',{action:'credentials:mint',returnTo:'/app/connections'},h.owner);
  assert.equal(request.status,202,request.text);
  const href=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
  const response=await h.send('/auth/confirm',{token:new URL(href).searchParams.get('token')},h.owner);
  assert.equal(response.status,303,response.text);
}
export function signedGatewayHeaders(state,path,input,{timestamp=Math.floor(Date.now()/1000),nonce=randomBytes(32).toString('base64url'),privateKey=state.private_key}={}) {
  const raw=JSON.stringify(input),message=`crank-gateway-request-v1\nPOST\n${path}\n${createHash('sha256').update(raw).digest('hex')}\n${timestamp}\n${nonce}`;
  return {'x-crank-gateway-id':state.gateway.id,'x-crank-environment':input.environment,'x-crank-timestamp':String(timestamp),'x-crank-nonce':nonce,'x-crank-signature':sign(null,Buffer.from(message),createPrivateKey({key:Buffer.from(privateKey,'base64url'),format:'der',type:'pkcs8'})).toString('base64url')};
}
export const pollPayload=text=>{const envelope=typeof text==='string'?JSON.parse(text):text;return envelope.payload?JSON.parse(envelope.payload):envelope};
export async function gatewayPost(h,state,path,input,status=200,options) {
  if(!path.startsWith('/'))path='/api/crank/'+path;
  const result=await h.send(path,input,'',signedGatewayHeaders(state,path,input,options));
  assert.equal(result.status,status,result.text);return result.value;
}
/** Test-only conversion of local edge fixtures to the named host custody format. */
export function namedManifest(manifest) {
  const result=structuredClone(manifest);result.credentials??={};
  for(const [name,operation]of Object.entries(result.operations)) {
    if(!operation.connection)continue;
    const secret={};
    for(const field of ['user','username','password','privateKey','passphrase','accessKeyId','secretAccessKey','sessionToken'])if(operation.connection[field]!==undefined){secret[field]=operation.connection[field];delete operation.connection[field]}
    if(Object.keys(secret).length){operation.credential=name;result.credentials[name]=secret}
  }
  return result;
}
export function manifestDestinations(manifest,path) {
  const found=new Map();
  for(const op of Object.values(manifest.operations)) {
    const c=op.connection??{};let spec;
    if(['postgres-query','mysql-query','sqlserver-query'].includes(op.type))spec={type:'database',host:c.host??c.server,port:c.port??({'postgres-query':5432,'mysql-query':3306,'sqlserver-query':1433}[op.type]),database:c.database};
    else if(op.type==='sftp-lines')spec={type:'sftp',host:c.host,port:c.port??22,path_prefix:op.path};
    else if(op.type==='s3-lines')spec={type:'s3',endpoint:c.endpoint,bucket:op.bucket,prefix:op.key};
    else spec={type:'local',path:resolve(path,'..',op.database??op.path)};
    found.set(op.destination,{label:op.destination,...spec});
  }
  return [...found.values()];
}
