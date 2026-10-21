import {spawn} from 'node:child_process';
import {cp,mkdtemp,mkdir,chmod,chown,rm,readFile,copyFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {fakeSecret,until} from './kit.mjs';

/** Deploy the real Linux service outside root's private home, as its own user.
 * Only DNS/socket routing is replaced in the Worker test's network edge. */
export async function linuxExecutor() {
 const root=await mkdtemp(join(tmpdir(),'crank-linux-')),uid=process.getuid()===0?65534:process.getuid(),gid=process.getuid()===0?65534:process.getgid();
 await chmod(root,0o755);
 const app=join(root,'linux'),data=join(root,'data'),modules=join(root,'node_modules'),binary=join(root,'node');
 await cp(resolve('executors/linux'),app,{recursive:true});await mkdir(data,{mode:0o700});await chown(data,uid,gid);await copyFile(process.execPath,binary);await chmod(binary,0o755);
 const esbuild=fileURLToPath(import.meta.resolve('esbuild')),req=createRequire(esbuild),native=dirname(req.resolve('@esbuild/linux-x64/package.json'));
 await mkdir(join(modules,'@esbuild'),{recursive:true});await cp(dirname(dirname(esbuild)),join(modules,'esbuild'),{recursive:true,dereference:true});await cp(native,join(modules,'@esbuild/linux-x64'),{recursive:true,dereference:true});
 await writeFile(join(root,'start.mjs'),`import {startExecutor} from './linux/server.mjs';\ntry {const e=await startExecutor();console.log('Crank Linux executor listening on 127.0.0.1:'+e.address.port);for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>e.close().then(()=>process.exit(0),()=>process.exit(1)));}catch(error){console.error(error.message);process.exitCode=1}`);
 const token=fakeSecret('isolated-executor');let child,log='';
 const start=async()=>{
  log='';child=spawn(binary,[join(root,'start.mjs')],{cwd:root,uid,gid,env:{PATH:'/usr/bin:/bin',CRANK_EXECUTOR_TOKEN:token,CRANK_EXECUTOR_DATA:data,CRANK_EXECUTOR_PORT:'0'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  const port=await until(()=>{if(child.exitCode!==null)throw Error('Executor startup failed: '+log);return /listening on 127.0.0.1:(\d+)/.exec(log)?.[1]},'real Linux executor readiness',10000);
  return `http://127.0.0.1:${port}`;
 };
 let origin=await start();
 const stop=async(signal='SIGTERM')=>{const previous=child;if(previous.exitCode!==null)return;const stopped=new Promise(r=>previous.once('close',r));previous.kill(signal);await stopped};
 const call=async(path,body,authorization=token)=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+authorization,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)}).catch(error=>{throw new Error(`Executor transport failed (exit=${child.exitCode}, signal=${child.signalCode}): ${log}`,{cause:error})});return {status:response.status,value:await response.json()}};
 return {get origin(){return origin},token,call,async restart(crash=false){await stop(crash?'SIGKILL':'SIGTERM');origin=await start()},async close(){await stop();await rm(root,{recursive:true,force:true})}};
}
