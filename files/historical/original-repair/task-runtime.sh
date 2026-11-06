. /tmp/rer-cloud-toolchain.sh
export PATH="$HOME/.rer/toolchain/node-22.20.0/node_modules/node/bin:$PATH"
export CI=true
export WRANGLER_SEND_METRICS=false
export PLAYWRIGHT_SKIP_BROWSER_GC=1
export PLAYWRIGHT_BROWSERS_PATH="$HOME/rer-consolidation/work/sx-crank-f64-ci-repair-1/browser-cache"
[ "$(node --version)" = v22.20.0 ] || return 64
[ "$(pnpm --version)" = 10.12.4 ] || return 64
