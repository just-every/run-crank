import datetime,json,subprocess,time
from pathlib import Path
root=Path.home()/'rer-consolidation/work/sx-crank-f64-ci-triage-1-setup1'
p=root/'packet'
assert not (p/'main-build-started.json').exists(), 'main build already admitted'
assert not (p/'main-owner-decisions-started.json').exists(), 'main shard already admitted'
while not (p/'candidate-owner-decisions-receipt.json').exists():time.sleep(0.5)
candidate=json.loads((p/'candidate-owner-decisions-receipt.json').read_text())
print('Candidate shard completed exit',candidate['exit'],'; main build starts once',flush=True)
code=subprocess.run(['python3','/tmp/rer-f64-phase.py','main','build','timeout','1200','node','scripts/verify-ci.mjs','--build']).returncode
if code==0:
 code=subprocess.run(['python3','/tmp/rer-f64-phase.py','main','owner-decisions','timeout','1200','env','CRANK_EVIDENCE='+str(p/'main-artifacts'),'node','scripts/verify-ci.mjs','owner-decisions']).returncode
else:print('Main build failed; main shard not started',flush=True)
(p/'pair-coordinator-receipt.json').write_text(json.dumps({'candidate_owner_decisions_exit':candidate['exit'],'main_last_phase_exit':code,'finished_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'retries':0},indent=2)+'\n')
raise SystemExit(code)
