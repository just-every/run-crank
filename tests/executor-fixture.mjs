import {spawn,execFileSync} from 'node:child_process';
import {cp,mkdtemp,mkdir,chmod,chown,rm,readFile,readdir,rmdir,copyFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {fakeSecret,until} from './kit.mjs';

/** Fake only the remote executor protocol. No submitted source is evaluated;
 * callers supply explicit remote results. This proves no host isolation claim. */
export function executorProtocolEdge() {
 const token=fakeSecret('migration-executor'),tasks=new Map(),submitted=[];
 const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 const edge=async request=>{
  const url=new URL(request.url);if(url.hostname!=='executor.example')return undefined;
  if(request.headers.get('authorization')!=='Bearer '+token)return reply({error:'unauthorized'},401);
  const task_id=url.pathname.split('/')[2];
  if(request.method==='POST'){
   const job=await request.json();submitted.push({task_id,job});
   if(!tasks.has(task_id))tasks.set(task_id,{task_id,status:'running'});
  }
  return tasks.has(task_id)?reply(tasks.get(task_id)):reply({error:'not_found'},404);
 };
 return {token,edge,tasks,submitted,complete(task_id,output){tasks.set(task_id,{task_id,status:'succeeded',output})}};
}

/** Deploy the real Linux service outside root's private home, as its own user.
 * Only DNS/socket routing is replaced in the Worker test's network edge. */
export async function linuxExecutor({quota=true}={}) {
 const root=await mkdtemp(join(tmpdir(),'crank-linux-')),uid=process.getuid()===0?65534:process.getuid(),gid=process.getuid()===0?65534:process.getgid();
 await chmod(root,0o755);
 let cgroup;
 if(quota){
  // This registered journey requires real kernel enforcement, never a fake tree.
  cgroup=join('/sys/fs/cgroup','crank-test-'+root.split('/').at(-1));
  try{
   await writeFile('/sys/fs/cgroup/cgroup.subtree_control','+memory +pids');
   await mkdir(cgroup);await writeFile(join(cgroup,'cgroup.subtree_control'),'+memory +pids');
   await mkdir(join(cgroup,'service'));
   for(const file of ['', 'cgroup.procs','cgroup.threads','cgroup.subtree_control'])await chown(join(cgroup,file),uid,gid);
  }catch(error){await rm(root,{recursive:true,force:true});throw Error('CGROUP_V2_DELEGATION_REQUIRED: real Linux quota proof needs delegated memory, swap and pids controls ('+error.code+')')}
 }

 const app=join(root,'linux'),data=join(root,'data'),modules=join(root,'node_modules'),binary=join(root,'node');
 await cp(resolve('executors/linux'),app,{recursive:true});await mkdir(data,{mode:0o700});await chown(data,uid,gid);await copyFile(process.execPath,binary);await chmod(binary,0o755);
 const esbuild=fileURLToPath(import.meta.resolve('esbuild')),req=createRequire(esbuild),native=dirname(req.resolve('@esbuild/linux-x64/package.json'));
 await mkdir(join(modules,'@esbuild'),{recursive:true});await cp(dirname(dirname(esbuild)),join(modules,'esbuild'),{recursive:true,dereference:true});await cp(native,join(modules,'@esbuild/linux-x64'),{recursive:true,dereference:true});
 await writeFile(join(root,'start.mjs'),`import {startExecutor} from './linux/server.mjs';\ntry {const e=await startExecutor();console.log('Crank Linux executor listening on 127.0.0.1:'+e.address.port);for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>e.close().then(()=>process.exit(0),()=>process.exit(1)));}catch(error){console.error(error.message);process.exitCode=1}`);
 const token=fakeSecret('isolated-executor');let child,log='';
 const start=async()=>{
  log='';
  const env={PATH:'/usr/bin:/bin',CRANK_EXECUTOR_TOKEN:token,CRANK_EXECUTOR_DATA:data,CRANK_EXECUTOR_PORT:'0',...(cgroup?{CRANK_EXECUTOR_CGROUP:cgroup}:{})};
  const enter='import os,sys; open(sys.argv[1],"w").write(str(os.getpid())); os.setgroups([]); os.setgid(int(sys.argv[3])); os.setuid(int(sys.argv[2])); os.execve(sys.argv[4],[sys.argv[4],sys.argv[5]],os.environ)';
  child=cgroup?spawn('/usr/bin/python3',['-I','-S','-c',enter,join(cgroup,'service','cgroup.procs'),String(uid),String(gid),binary,join(root,'start.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']}):spawn(binary,[join(root,'start.mjs')],{cwd:root,uid,gid,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  const port=await until(()=>{if(child.exitCode!==null)throw Error('Executor startup failed: '+log);return /listening on 127.0.0.1:(\d+)/.exec(log)?.[1]},'real Linux executor readiness',10000);
  return `http://127.0.0.1:${port}`;
 };
 let origin=await start();
 const stop=async(signal='SIGTERM')=>{const previous=child;if(previous.exitCode!==null)return;const stopped=new Promise(r=>previous.once('close',r));previous.kill(signal);await stopped};
 const call=async(path,body,authorization=token)=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+authorization,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)}).catch(error=>{throw new Error(`Executor transport failed (exit=${child.exitCode}, signal=${child.signalCode}): ${log}`,{cause:error})});return {status:response.status,value:await response.json()}};
 return {get origin(){return origin},token,call,cgroup,data,crashSupervisor(){const children=execFileSync('ps',['--ppid',String(child.pid),'-o','pid=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/));const supervisor=children.find(([,command])=>command==='python3');if(!supervisor)throw Error('No owned supervisor found');process.kill(Number(supervisor[0]),'SIGKILL')},groups:async()=>cgroup?(await readdir(cgroup)).filter(name=>name.startsWith('task-')):[],async restart(crash=false){await stop(crash?'SIGKILL':'SIGTERM');origin=await start()},async close(){await stop();if(cgroup){await until(async()=>!(await readdir(cgroup)).some(name=>name.startsWith('task-')),'quota cleanup',10000);await until(async()=>!(await readFile(join(cgroup,'service','cgroup.events'),'utf8')).includes('populated 1'),'supervisor exit',10000);await rmdir(join(cgroup,'service'));await rmdir(cgroup)}await rm(root,{recursive:true,force:true})}};
}
