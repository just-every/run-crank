import datetime,json,os,pathlib,subprocess,time
root=pathlib.Path('/workspace/run-crank')
packet=pathlib.Path.home()/'rer-consolidation/work/sx-crank-flake-1/packet'
rows=[]
for iteration in range(1,11):
 for name in ['inbound-email','sample']:
  log=packet/f'repeat-{iteration:02d}-{name}.log'
  proof=pathlib.Path('/tmp/crank-proof')/f'{iteration:02d}'/name
  env=dict(os.environ,CRANK_EVIDENCE=str(proof),CRANK_CHROMIUM='/usr/bin/chromium')
  command=['node']+(['--import','/tmp/crank-cpu-throttle.mjs'] if iteration==10 else [])+['tests/'+name+'-browser.mjs']
  head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
  start=time.time()
  with log.open('w') as out:
   result=subprocess.run(command,cwd=root,env=env,stdout=out,stderr=subprocess.STDOUT)
  row=dict(iteration=iteration,journey=name,command=command,head=head,cpu_throttle=6 if iteration==10 else 1,exit=result.returncode,elapsed_seconds=round(time.time()-start,2),log=log.name)
  rows.append(row)
  (packet/'repeat-receipt.json').write_text(json.dumps(rows,indent=2)+'\n')
  print(json.dumps(row),flush=True)
  if result.returncode:
   print(log.read_text()[-6000:],flush=True)
   raise SystemExit(result.returncode)
