// Local-only Worker entry. vite.config.ts loads it only for `vite dev`; the
// deployed main stays src/server.ts, and `rer build` refuses any output that
// contains the dev layer. It adds dev sign-in, personas and the dev badge.
import worker from './server'
import { withDevIdentity } from './modules/operator-auth/dev/index.mjs'
import { authConfig, runtimeBindings, type Bindings } from './auth.server'
import { devPersonas } from './dev-personas'
import { withDevAi } from './modules/ai/dev/index.mjs'

const development = withDevAi<Bindings, typeof worker>(worker, { bindings: runtimeBindings })
export default withDevIdentity<Bindings, typeof worker>(development, { bindings: runtimeBindings, config: authConfig, personas: devPersonas })
