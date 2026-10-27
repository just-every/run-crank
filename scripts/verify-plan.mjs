import {appendFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
const repository=process.env.GITHUB_REPOSITORY, sha=process.env.GITHUB_SHA;
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
async function api(path) {
 const response=await fetch(`https://api.github.com/repos/${repository}/${path}`,{headers:{authorization:`Bearer ${process.env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error(`Verification evidence unavailable: HTTP ${response.status}`);
 return response.json();
}
async function green(head,otherBranch=false) {
 const list=await api(`actions/workflows/verify.yml/runs?head_sha=${head}&event=push&per_page=100`);
 if(!Array.isArray(list.workflow_runs)||list.total_count>100)throw Error('Incomplete verification evidence');
 const runs=list.workflow_runs.filter(run=>run.head_sha===head&&run.event==='push'&&String(run.id)!==process.env.GITHUB_RUN_ID&&(!otherBranch||run.head_branch!=='main')).sort((a,b)=>b.run_number-a.run_number);
 const newest=runs[0];
 if(!newest||newest.status!=='completed'||newest.conclusion!=='success')return false;
 const jobs=await api(`actions/runs/${newest.id}/jobs?per_page=100`);
 if(!jobs.jobs?.length||jobs.total_count>100)return false;
 // Reuse only a full successful push, with all its selected work completed.
 const work=jobs.jobs.filter(job=>!['plan','verify'].includes(job.name));
 return work.length>0&&work.every(job=>job.status==='completed'&&job.conclusion==='success');
}
let skip=false;
try {
 if(process.env.GITHUB_EVENT_NAME==='push'&&process.env.GITHUB_REF==='refs/heads/main')skip=await green(sha,true);
 if(process.env.GITHUB_EVENT_NAME==='pull_request'&&event.pull_request?.head.repo.full_name===repository)skip=await green(event.pull_request.head.sha);
 if(!skip&&process.env.GITHUB_EVENT_NAME==='push') {
  const parent=git('rev-parse',`${sha}^`);
  if(git('rev-parse',`${sha}^{tree}`)===git('rev-parse',`${parent}^{tree}`))skip=await green(parent);
 }
} catch(error) { console.log(error.message); }
appendFileSync(process.env.GITHUB_OUTPUT,`skip=${skip}\n`);
console.log(skip?'Reuse completed full push verification':'Run every selected shard');
