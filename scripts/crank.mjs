#!/usr/bin/env node
// Agent commands intentionally contain no approval verb.
import {readFile,lstat} from 'node:fs/promises';
const [command,...args]=process.argv.slice(2);
if(!command || command==='--help') {
 console.log('Crank agent commands: state | prepare-flow FILE | prepare-run FLOW_ID FILE | trigger FLOW_ID FILE\nSet CRANK_ORIGIN and CRANK_TOKEN_FILE (a private token file). Optional CRANK_DEV_KEY_FILE supplies the local dev gate. FILE is a JSON request object. People approve in /app.');
 process.exit(0);
}
async function privateValue(path) {
 if(!path)throw Error('Set CRANK_TOKEN_FILE to a private credential file.');
 const stat=await lstat(path);
 if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || (stat.mode&0o077))throw Error('Credential files must be regular, single-link and mode 0600.');
 return (await readFile(path,'utf8')).trim();
}
try {
 const origin=new URL(process.env.CRANK_ORIGIN || '');
 if(origin.origin!==process.env.CRANK_ORIGIN || origin.username || origin.password || (origin.protocol!=='https:' && !(origin.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname))))throw Error('Set CRANK_ORIGIN to the exact HTTPS or local loopback origin.');
 const commands={state:{path:'state',args:0},'prepare-flow':{path:'flows',args:1},'prepare-run':{path:`flows/${encodeURIComponent(args[0])}/runs`,args:2},trigger:{path:`flows/${encodeURIComponent(args[0])}/trigger`,args:2}};
 const operation=commands[command];if(!operation || args.length!==operation.args)throw Error('Unknown command or arguments. Run --help.');
 const token=await privateValue(process.env.CRANK_TOKEN_FILE);
 const headers={'authorization':'Bearer '+token,'content-type':'application/json'};
 if(process.env.CRANK_DEV_KEY_FILE)headers['x-rer-dev-key']=await privateValue(process.env.CRANK_DEV_KEY_FILE);
 const input=command==='state'?undefined:JSON.parse(await readFile(args.at(-1),'utf8'));
 const response=await fetch(origin.origin+'/api/crank/'+operation.path,{method:input===undefined?'GET':'POST',headers,redirect:'manual',signal:AbortSignal.timeout(15000),...(input===undefined?{}:{body:JSON.stringify(input)})});
 const value=await response.json();if(!response.ok)throw Error(value.error || 'Command refused');
 console.log(JSON.stringify(value,null,2));
}catch(error){console.error(error instanceof SyntaxError?'Invalid JSON request file.':error.message);process.exitCode=1;}
