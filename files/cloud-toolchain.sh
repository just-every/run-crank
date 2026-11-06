export NODE_USE_ENV_PROXY=1
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
_rer_pins="$(python3 - <<'RER_PINS'
import json, re
from pathlib import Path

def first(text):
    m = re.search(r'\d+\.\d+\.\d+', text)
    return m.group(0) if m else ''

node = ''
for name in ('.nvmrc', '.node-version'):
    path = Path(name)
    if path.is_file():
        node = first(path.read_text())
    if node:
        break
pkg = json.loads(Path('package.json').read_text()) if Path('package.json').is_file() else {}
node = node or first((pkg.get('engines') or {}).get('node', ''))
manager = pkg.get('packageManager', '')
pnpm = first(manager) if manager.startswith('pnpm@') else '10.12.4'
print(node, pnpm)
RER_PINS
)"
_rer_node_want="${_rer_pins%% *}"; _rer_pnpm_want="${_rer_pins##* }"
_rer_tc="$HOME/.rer/toolchain"
_rer_have_node="$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)"
if [ -n "$_rer_node_want" ] && [ "$(printf '%s\n%s\n' "$_rer_node_want" "$_rer_have_node" | sort -V | head -n1)" != "$_rer_node_want" ]; then
  [ -x "$_rer_tc/node-$_rer_node_want/node_modules/node/bin/node" ] || timeout 300 npm install --prefix "$_rer_tc/node-$_rer_node_want" --no-audit --no-fund "node@$_rer_node_want" >>/tmp/rer-toolchain.log 2>&1 || echo "rer toolchain: node@$_rer_node_want install failed (see /tmp/rer-toolchain.log)" >&2
  [ -x "$_rer_tc/node-$_rer_node_want/node_modules/node/bin/node" ] && export PATH="$_rer_tc/node-$_rer_node_want/node_modules/node/bin:$PATH"
fi
if [ "$(pnpm --version 2>/dev/null)" != "$_rer_pnpm_want" ]; then
  [ -x "$_rer_tc/pnpm-$_rer_pnpm_want/node_modules/.bin/pnpm" ] || timeout 300 npm install --prefix "$_rer_tc/pnpm-$_rer_pnpm_want" --no-audit --no-fund "pnpm@$_rer_pnpm_want" >>/tmp/rer-toolchain.log 2>&1 || echo "rer toolchain: pnpm@$_rer_pnpm_want install failed (see /tmp/rer-toolchain.log)" >&2
  [ -x "$_rer_tc/pnpm-$_rer_pnpm_want/node_modules/.bin/pnpm" ] && export PATH="$_rer_tc/pnpm-$_rer_pnpm_want/node_modules/.bin:$PATH"
fi
export PATH="$HOME/.rer/pnpm/pnpm-$_rer_pnpm_want/shim:$PATH"
echo "rer toolchain: node $(node -v 2>/dev/null) pnpm $(pnpm --version 2>/dev/null) (pins ${_rer_node_want:-none} / $_rer_pnpm_want)" >&2
unset _rer_pins _rer_node_want _rer_pnpm_want _rer_tc _rer_have_node

cat > /tmp/rer-reap.py <<'PY'
import ctypes, os, subprocess, sys

libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0):
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
child = subprocess.Popen(sys.argv[1:])
result = None
while True:
    try:
        pid, status = os.waitpid(-1, 0)
        if pid == child.pid:
            result = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        break
sys.exit(result if result is not None else 1)
PY

cloud_run() { python3 /tmp/rer-reap.py "$@"; }
