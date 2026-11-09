// Resume the unchanged checks after the seed callback in installed rer's
// cli/lifecycle.mjs. The initial public rer verify stopped at a missing site
// artifact; its 46 passing tests and the repaired callback commands are retained.
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from '/workspace/run-crank/node_modules/@playwright/test/index.mjs';
import {checkoutPlaywright} from '/workspace/run-crank/node_modules/@runeditrun/rer/cli/browser-runtime.mjs';
import {resolveProject} from '/workspace/run-crank/node_modules/@runeditrun/rer/cli/project.mjs';
import {checkHostedOutput} from '/workspace/run-crank/node_modules/@runeditrun/rer/cli/hosted-output.mjs';
import {checkHydration} from '/workspace/run-crank/node_modules/@runeditrun/rer/cli/hydration/check.mjs';
import {checkAgentDoor} from '/workspace/run-crank/node_modules/@runeditrun/rer/cli/agent-door.mjs';

// Cloud's required Chromium executable and sandbox flag, retaining all default
// Playwright arguments and every argument the installed checker supplies.
const browsers=new Set([chromium,checkoutPlaywright(process.cwd()).playwright.chromium]);
for(const browser of browsers){const launch=browser.launch.bind(browser);browser.launch=options=>launch({...options,headless:true,executablePath:'/usr/bin/chromium',args:[...(options?.args??[]),'--no-sandbox']});}
const root=process.cwd(),{adapter}=await resolveProject(root);
const declaration=adapter.deployDeclaration??adapter.deploy?.declaration;
const phase=process.argv[2];
const report={phase,product_head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),source:'Installed rer 0.2.105 cli/lifecycle.mjs verification sequence',declaration,status:'RUNNING'};
try {
 let result;
 if(phase==='hosted') result=await checkHostedOutput(root,{declaration});
 else if(phase==='hydration') result=await checkHydration(root,{pages:adapter.publicPages,declaration,report:lines=>lines.forEach(line=>console.log(line))});
 else if(phase==='agent') result=await checkAgentDoor(root,{declaration,setupManifest:JSON.parse(await readFile('rer-setup.json','utf8')),owner:adapter.hooks?.owner,report:line=>console.log(line)});
 else throw Error('Select hosted, hydration or agent');
 report.status='PASS';
 if(Array.isArray(result?.points)){report.points=result.points.length;report.passed=result.points.filter(point=>point.ok).length;report.failed=result.points.filter(point=>!point.ok).map(point=>point.id);}
 if(phase==='hydration'){report.pages=result?.pages?.map(page=>typeof page==='string'?page:page.path);report.loads=result?.loads;}
 console.log(JSON.stringify(report));
} catch(error) {
 report.status='FAIL';report.error_code=error.code??error.name;
 report.error=String(error.message).replace(/https?:\/\/[^\s]+/g,url=>url.split('?')[0]).replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,'<REDACTED_SESSION>').slice(0,1500);
 console.error(JSON.stringify(report));process.exitCode=1;
} finally {await writeFile(new URL('foundation-'+phase+'-receipt.json',import.meta.url),JSON.stringify(report,null,2)+'\n');}
