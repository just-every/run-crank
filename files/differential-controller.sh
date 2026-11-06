#!/bin/bash
set -u
TASK_ROOT="$HOME/rer-consolidation/work/sx-crank-f64-ci-triage-1"
for input in candidate main; do
  cd "$TASK_ROOT/$input" || exit 1
  . /tmp/rer-cloud-toolchain.sh
  export PATH="$HOME/.rer/toolchain/node-22.20.0/node_modules/node/bin:$PATH"
  export CI=true WRANGLER_SEND_METRICS=false PLAYWRIGHT_SKIP_BROWSER_GC=1
  export CRANK_CHROMIUM_EXECUTABLE=/usr/bin/chromium
  export CRANK_EVIDENCE="$TASK_ROOT/private-runtime/$input"
  test "$(node -p process.versions.node)" = 22.20.0 || exit 1
  test -z "$(git status --porcelain=v1)" || exit 1
  for phase in build shard; do
    phase_start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [ "$phase" = build ]; then
      cloud_run timeout --signal=TERM --kill-after=30s 1200 node scripts/verify-ci.mjs --build > "$TASK_ROOT/packet/$input-build.log" 2>&1
      phase_exit=$?
    else
      cloud_run timeout --signal=TERM --kill-after=30s 1200 node scripts/verify-ci.mjs owner-decisions > "$TASK_ROOT/packet/$input-owner-decisions.log" 2>&1
      phase_exit=$?
    fi
    phase_end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    python3 - "$input" "$phase" "$phase_start" "$phase_end" "$phase_exit" "$$" <<'PY'
import sys,json,subprocess,hashlib
from pathlib import Path
name,phase,start,end,code,pid=sys.argv[1:]
root=Path.home()/'rer-consolidation/work/sx-crank-f64-ci-triage-1'
row={'input':name,'phase':phase,'start':start,'end':end,'exit':int(code),'controller_pid':int(pid),'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'status':subprocess.check_output(['git','status','--porcelain=v1'],text=True),'node':subprocess.check_output(['node','--version'],text=True).strip(),'pnpm':subprocess.check_output(['pnpm','--version'],text=True).strip(),'lock_sha256':hashlib.sha256(Path('pnpm-lock.yaml').read_bytes()).hexdigest(),'command':'cloud_run timeout --signal=TERM --kill-after=30s 1200 node scripts/verify-ci.mjs '+('--build' if phase=='build' else 'owner-decisions')}
(root/'packet'/f'{name}-{phase}-receipt.json').write_text(json.dumps(row,indent=2)+'\n')
print(json.dumps(row),flush=True)
PY
    if [ "$phase" = build ] && [ "$phase_exit" -ne 0 ]; then
      printf 'SHARD_NOT_RUN input=%s prerequisite=ordinary-build exit=%s\n' "$input" "$phase_exit"
      break
    fi
  done
done
