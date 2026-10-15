# AI client

`ai` implements Base's `ai.provider.v1` slot. Copy this module with the matching
`operator-auth` module, as with mail. Import production code from `ai/index.mjs`.
There are no SDK dependencies, automatic retries, schema repairs or provider
fallbacks. The seed owns enablement, consent, deadlines, budgets and retry policy.

```js
import { aiConfig, createAiClient, AiError } from './modules/ai/index.mjs';
const ai = createAiClient(aiConfig(env, { images: 'direct' }));
const response = await ai.responses({
  model: 'openai/exact-model-id', input: approvedInput, store: false,
}, { feature: 'analysis', signal: request.signal });
```

`chat`, `responses` and `embeddings` return the raw `Response`, including raw
usage, receipt headers and native SSE. Streaming passes through without buffering.
Consume JSON or SSE in the seed's own format. Embeddings have no native streaming
format; the direct transport passes the caller's fields without translating them.
`receipt(id)` calls the linked service's receipt endpoint. An omitted feature
leaves Models to use the app key's first/default feature. Do not forward
`x-models-*` headers to browsers. Pinned names (provider name, slash, then exact model ID) require an exact
`x-models-target` match when linked; aliases (including `@app/alias`) do not.

`AI_ENABLED=true` is required. Direct calls use `AI_API_KEY`, `AI_MODEL` and
`AI_BASE_URL` (defaults to OpenAI's `/v1`). Any OpenAI-compatible URL works,
including OpenRouter or Cloudflare AI Gateway. Direct calls preserve the supplied
API path prefix. Linked calls use `MODELS_SERVICE`
and `MODELS_KEY`. Neither a link nor credentials turn AI on. URLs must be HTTPS
or local loopback HTTP, with no credentials, query or fragment. Redirects fail.

Both transports configured for a feature give `AiError.code ===
'ai_misconfigured'` when called, and diagnostics in `rer check` and `rer doctor`.
The app still starts. Declare `ai: { features: { images: 'direct' } }` on the
command adapter and pass the same feature map to `aiConfig` for capabilities
that deliberately use their own provider key while the app is linked. An
explicit feature transport never falls through to the other transport.

For a custom provider-edge adapter, `createAiClient(config, { transport })`
accepts `request({operation,body,feature,signal,selected}) -> Response`; selection,
enablement and pinned-target checks still apply. Ordinary HTTP uses `{ fetch }`.
Errors expose fixed text and typed codes, never upstream exception messages.

## Local development

The reference and composed foundation mount `withDevAi` from `./dev/index.mjs` in their
local-only Worker entry. `GET /__dev/ai` lists captures as JSON. POST to
`/__dev/ai/v1/chat/completions`, `/responses`, or `/embeddings` to call the double.
Every surface needs operator-auth's `RER_DEV_KEY` header or its exchanged,
host-only cookie. Requests without the key return 404 even through a proxy.

Product routes can import `createDevAiClient` in their local-only implementation;
it also checks the originating product request's key gate. AI enablement still
comes from the seed. A local call answers text as `[dev] <feature> <hash8>`
(two chunks when streamed), `json_object` as `{}`, and embeddings as deterministic
input-derived vectors. Schema output and forced tools throw
`dev_fake_cannot_answer` with instructions to use a capped Models dev app.
The double produces development output only; it cannot stand in for a real
product result. `./fake/index.mjs` supports a supplied `script` for provider-edge tests.

Outbox rows use local D1 and survive restarts. They are bounded by age and count,
excluded from installation exports, and deleted with D1 by `rer reset --yes`.
Capture failures return `dev_outbox_unavailable` and close any live response.
Production imports neither `./dev/index.mjs` nor `./fake/index.mjs`. `rer build` scans output for
their marker and refuses a bundle containing it, even without dev identity.

For live dev, first create a Models **dev app** with a low cap, short expiry and
cheap model allow-list. Models enforces those limits; the client does not invent
a local budget or claim that the key prefix proves a cap. Pipe its key on stdin:

```sh
your-secret-reader | rer dev --models live --models-service https://models.example
```

The key is saved in `.rer/local/models.json` (0600, directories 0700), never in
arguments or tracked settings. Subsequent `rer dev --models live` reads the file,
checks the app's authenticated model catalogue, and prints
`RER_MODELS_LIVE <origin> via <providers>`. No failed live call switches to the
double. Live outbox rows contain receipt metadata and fixed error codes only.
`rer check` and `rer doctor` flag unsafe storage. A default `rer dev` still uses
the double, even when a live file exists. Stop dev before changing modes.

Build hides the private file and restores it afterward. Deploy, dry-run deploy
and deployment artifact/plan preparation refuse it; local binding names are
refused in deploy declarations too. Remove it explicitly before deployment.
`rer reset --yes` deletes it along with the checkout's other local-only state.

Models routing, billing and app administration, Worker probes and Pencil's first
analytics journey belong to their separate tasks. No provider account is needed
to run this module's tests.
