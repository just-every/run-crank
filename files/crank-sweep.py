import json,os,pathlib,subprocess,time
root=pathlib.Path('/workspace/run-crank');packet=pathlib.Path.home()/'rer-consolidation/work/sx-crank-flake-1/packet'
# Verify entry points transitively invoke Gmail/Typeform and Teams/HubSpot.
commands=[('ai-steps',['node','tests/ai-steps-browser.mjs']),('digest',['node','tests/digest-browser.mjs']),('sibling',['node','tests/sibling-browser.mjs']),('calendar-search',['node','tests/google-calendar-search-browser.mjs']),('editor',['node','tests/agent-door/attribution-browser.mjs'])]
rows=json.loads((packet/'sweep-receipt.json').read_text()) if (packet/'sweep-receipt.json').exists() else []
for name,command in commands:
 log=packet/f'sweep-{name}.log';start=time.time();head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
 env=dict(os.environ,CRANK_EVIDENCE='/tmp/crank-sweep-proof/'+name,CRANK_CHROMIUM='/usr/bin/chromium',CRANK_CHROMIUM_EXECUTABLE='/usr/bin/chromium',PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/usr/bin/chromium')
 with log.open('w') as out:result=subprocess.run(command,cwd=root,env=env,stdout=out,stderr=subprocess.STDOUT)
 row=dict(journey=name,command=command,head=head,exit=result.returncode,elapsed_seconds=round(time.time()-start,2),log=log.name)
 rows.append(row);(packet/'sweep-receipt.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)
 if result.returncode:
  print(log.read_text()[-6000:],flush=True)
  raise SystemExit(result.returncode)
