import json,re
from pathlib import Path
p=Path.home()/'rer-consolidation/work/sx-crank-f64-ci-triage-1-setup1/packet'
rows=[]
for f in sorted(p.rglob('*')):
 if f.is_symlink():raise SystemExit('symlink in packet')
 if not f.is_file() or f.suffix not in ['.log','.txt']:continue
 text=f.read_text()
 text,count=re.subn(r'(https?://[^\s?#<>]+)[?#][^\s<>]+',r'\1 [PRIVATE URL SUFFIX REDACTED]',text)
 text,markers=re.subn(r'(RER_OPEN\s+)(?!\[)\S+',r'\1[PRIVATE LOCAL SIGN-IN URL REDACTED]',text)
 if count or markers:
  f.write_text(text)
  rows.append({'file':str(f.relative_to(p)),'private_url_suffixes_removed':count,'private_markers_removed':markers})
for f in p.rglob('*'):
 if f.is_file() and f.suffix in ['.md','.txt','.json','.log','.diff','.py','.sh']:
  text=f.read_text()
  checks=[r'(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}',r'rer-dev=[A-Za-z0-9_-]{15,}',r'(?i)(?:access_token|refresh_token|client_secret)[\"\x27]?\s*[:=]\s*[\"\x27]?[A-Za-z0-9_-]{20,}']
  if any(re.search(pattern,text) for pattern in checks):raise SystemExit('publication secret-pattern check rejected file '+str(f.relative_to(p)))
(p/'redaction-receipt.json').write_text(json.dumps({'status':'passed','private_sign_in_links_excluded':True,'files_sanitized':rows,'credential_and_environment_files_selected':False,'runtime_secret_values_printed_in_packet':False},indent=2)+'\n')
print('packet redaction complete; URL suffixes removed',sum(r['private_url_suffixes_removed'] for r in rows))
