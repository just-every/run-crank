import hashlib,json,re
from pathlib import Path
root=Path.home()/'rer-consolidation/work/sx-crank-f64-ci-triage-1-setup1'
p=root/'packet'
rows=[]
for name in ['candidate','main']:
 source=root/name/'.seed/installer/install.log'
 if not source.is_file():continue
 raw=source.read_bytes()
 counts={'sensitive_label_lines_omitted':0,'private_url_lines_omitted':0}
 lines=[]
 for line in raw.decode(errors='replace').splitlines(True):
  if re.search(r'(?i)env\.[A-Z_]+|SESSION_SECRET|RER_DEV_KEY|MAIL_API_KEY|SETUP_TOKEN|PRIVATE_KEY|[\"\x27]?(?:access_token|refresh_token|client_secret|authorization|cookie|set-cookie)[\"\x27]?\s*[:=]',line):
   lines.append('[runtime binding or credential-labelled line omitted]\n');counts['sensitive_label_lines_omitted']+=1;continue
  if re.search(r'RER_OPEN|RER_SIGN_IN',line):
   lines.append('[private local sign-in line omitted]\n');counts['private_url_lines_omitted']+=1;continue
  line=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',line)
  line=re.sub(r'(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+','[REDACTED]',line)
  line=re.sub(r'(https?://[^\s?#<>]+)[?#][^\s<>]+',r'\1?[PRIVATE URL SUFFIX REDACTED]',line)
  line=re.sub(r'(?i)(authorization:\s*|password=|bearer\s+)\S+',r'\1[REDACTED]',line)
  lines.append(line)
 dest=p/(name+'-installer-sanitized.log')
 data=''.join(lines).encode();dest.write_bytes(data)
 rows.append({'input':name,'source':'task-created clone/.seed/installer/install.log','original_bytes':len(raw),'original_sha256':hashlib.sha256(raw).hexdigest(),'sanitized_file':dest.name,'sanitized_bytes':len(data),'sanitized_sha256':hashlib.sha256(data).hexdigest(),**counts,'no_environment_or_secret_files_read':True})
(p/'installer-log-receipt.json').write_text(json.dumps(rows,indent=2)+'\n')
print('sanitized task-created installer logs collected',json.dumps(rows))
