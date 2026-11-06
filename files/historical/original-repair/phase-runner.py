import datetime,json,os,re,shlex,subprocess,sys,time,threading
from pathlib import Path
root=Path.home()/'rer-consolidation/work/sx-crank-f64-ci-repair-1'
packet=root/'packet'
name,label,*command=sys.argv[1:]
assert name in ('before','after','final','setup','probe')
assert re.fullmatch('[a-z0-9-]+',label)
phase=name+'-'+label
shell='set -euo pipefail\n. /tmp/rer-f64-env.sh\nnode --version\npnpm --version\ncommand -v node\ncloud_run '+shlex.join(command)
row={'phase':phase,'cwd':str(root/'run-crank'),'command':command,'shell_prelude':'set -euo pipefail; . /tmp/rer-f64-env.sh; cloud_run','started_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'time_limit_seconds':1200}
log=packet/(phase+'.log')
watch_stop=threading.Event()
opened=[]
preexisting=set(Path('/tmp').glob('crank-decisions-*'))
def capture_dev_log():
 handles={}
 with (packet/(phase+'-dev-startup.log')).open('w') as dest:
  while not watch_stop.wait(0.1):
   for folder in Path('/tmp').glob('crank-decisions-*'):
    if folder in preexisting or folder in handles:continue
    file=folder/'dev.log'
    if file.is_file():
     handles[folder]=file.open()
     opened.append(str(file))
     dest.write('CAPTURE task-generated diagnostic log '+str(file)+'\n')
   for handle in handles.values():
    data=handle.read()
    if data:
     for line in data.splitlines(True):
      if re.search(r'(?i)(env\.[A-Z_]+|SESSION_SECRET|RER_DEV_KEY|MAIL_API_KEY|SETUP_TOKEN|PRIVATE_KEY)',line):
       dest.write('[runtime binding line omitted]\n')
      else:dest.write(clean(line))
     dest.flush()
  for handle in handles.values():
   for line in handle.read().splitlines(True):
    if re.search(r'(?i)(env\.[A-Z_]+|SESSION_SECRET|RER_DEV_KEY|MAIL_API_KEY|SETUP_TOKEN|PRIVATE_KEY)',line):dest.write('[runtime binding line omitted]\n')
    else:dest.write(clean(line))
   handle.close()
watcher=None

start=time.monotonic()
def clean(line):
 line=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',line)
 line=re.sub(r'(?i)(RER_OPEN\s+)\S+',r'\1[PRIVATE LOCAL SIGN-IN URL REDACTED]',line)
 line=re.sub(r'(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+','[REDACTED]',line)
 line=re.sub(r'(?i)(authorization:\s*|password=|bearer\s+)\S+',r'\1[REDACTED]',line)
 line=re.sub(r'(https?://[^\s?<>]+)\?[^\s<>]+',r'\1?[QUERY REDACTED]',line)
 return line
if label=='owner-decisions':
 watcher=threading.Thread(target=capture_dev_log,daemon=True);watcher.start()
with log.open('w') as out:
 out.write('COMMAND '+shlex.join(command)+'\nPRELUDE '+row['shell_prelude']+'\n')
 out.flush()
 proc=subprocess.Popen(['bash','-c',shell],cwd=root/'run-crank',stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
 row['literal_wrapper_pid']=proc.pid
 (packet/(phase+'-started.json')).write_text(json.dumps(row,indent=2)+'\n')
 for line in proc.stdout:
  out.write(clean(line));out.flush()
 code=proc.wait()
 watch_stop.set()
 if watcher:watcher.join()
 row['captured_dev_logs']=opened
 row.update(exit=code,duration_seconds=round(time.monotonic()-start,3),finished_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),log_file=log.name)
 out.write('\nPHASE_RECEIPT '+json.dumps(row,sort_keys=True)+'\n')
(packet/(phase+'-receipt.json')).write_text(json.dumps(row,indent=2)+'\n')
print('PHASE',phase,'exit='+str(code),'duration='+str(row['duration_seconds']),flush=True)
print('LOG',log,flush=True)
raise SystemExit(code)
