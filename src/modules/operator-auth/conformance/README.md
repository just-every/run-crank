# Operator-auth conformance

`index.mjs` exports `registerOperatorAuthConformance({ test, adapter })`. Import
that function once in a seed's Node test file and pass its existing Node test
registrar plus a test-only adapter for the seed's real Worker. The suite registers
checks for the HTTP contract, the same native session store, the seed's protected
private API, test-captured mail outcomes, and its configured limits. It does not
replace `createOperatorAuth`, use an in-memory auth fake, or require IdP credentials.

The frozen adapter contract is declared in `index.d.mts`. Its `open` method
receives a fresh test-only `AuthConfig`, one IF-056-shaped mail result, and an
explicit no-mail switch. It returns `call` for the actual Worker `/auth/*`
surface, `privateRequest` for one actual protected consumer API (with optional
test-only request headers for Host-boundary probes), `mails` for
messages captured by the test-only sender, and `close` for disposing all runtime
and D1 state. The test runtime must apply the consumer's actual numbered core
schema and use real workerd/D1; keep synthetic mail capture inside the test
adapter. Never expose this adapter or its fixture routes in application builds.

The default presentation remains asset-free. A consumer that intentionally adds
self-hosted fonts sets `adapter.confirmationFonts: true`. That profile requires
same-origin stylesheet and font-preload links, verifies the exact inline style
hash plus only same-origin style/font permissions, and still rejects external
origins, scripts, images and unsafe inline attributes. Mail stays self-contained.

A consumer that configures `branding.productName` or a seed theme
(`branding.theme`, its served `rer-theme.css`) or an installation mark
(`branding.mark`, for example `/brand/mark.svg`) declares the same values as
`adapter.branding: { productName, theme, mark }`. Mail and confirmation must then
carry that name, and a themed confirmation must hold exactly that one theme
stylesheet link and the CSP `style-src 'self' 'sha256-…'; font-src 'self';
img-src 'self'`. A declared mark requires exactly that image, with product-name
alt text, 32×32 dimensions and asynchronous decoding beside the text name;
without a theme its CSP adds only `img-src 'self'`. Every other resource rule
above still applies, and mail stays image-free.

The Base conformance registration is executable at
[`../tests/conformance.test.ts`](../tests/conformance.test.ts), and its D1/Worker
adapter lives in this directory's `tests/worker.mjs` and `tests/runtime.mjs`.
An adopting seed should map these methods to its actual Hono/Worker dispatcher
and native private API, then import and call the exported registration from its
existing test discovery path. No Base manifest or workflow is changed here.

The registered cases prove:

- first-owner bootstrap with no mail dependency, one owner, a native session,
  no duplicate owner claim, and no private API access without a session;
- GET and HEAD confirmation previews without cookie issuance, followed by one
  POST confirmation to the original safe `returnTo` and rejection of replay;
- neutral branding in magic/invitation previews and both mail parts,
  exact-byte stylesheet CSP, HEAD parity, single hidden POST token, plain subjects,
  one confirmation URL per mail part and configured invalid-link recovery;
- owner/admin/member boundaries, session revocation and session invalidation
  after an operator role change;
- local review issuance and subsequent session/private-API checks reject
  attacker-controlled Host values even when forwarded-Host headers claim
  loopback;
- allow-list masking and independent IP/email rate limits before mail effects;
- accepted, rejected and uncertain IF-056 mail results. Only `accepted` makes
  the link usable; rejected or uncertain delivery revokes it and returns
  `mail_unavailable`;
- optionally, owner-authorized provider sign-in enablement through the public
  settings route, then a first verified OIDC admission into an existing unbound owner
  through `admitVerifiedIdentity`, followed by access through the same native
  session route. This is a no-provider-key seam check, not an OIDC protocol
  check. The protocol, keys, PKCE, state, nonce and callback behavior remain
  covered by `modules/operator-auth/identity/oidc/tests/`.

The optional seam is enabled by setting `adapter.oidcIssuer` to one exact HTTPS
issuer and implementing `runtime.admitVerifiedIdentity`. It must call the real
trusted core seam with the issuer included in `externalIssuers`; the conformance
case starts from a fresh owner with no prior external identity binding. It makes
no claim that a changed issuer/subject can bind by matching email. Do not route
request-body identity data to this seam in the application.

The test sender returns only the IF-056 result shape. `accepted` is API
acceptance, not inbox delivery, and may have a null provider message ID. A real
adopter uses the selected `modules/mail/index.mjs` `createMailSender` with its
configured provider; a test sender is never a production path.

Custom branding is additionally checked against real D1 in the module runtime
suite. These shared cases are also consumed by default-seed; no provider sends are
required. Browser responsiveness, keyboard focus and pinned axe-core 4.10.3
audits run in `../tests/presentation-browser.test.mjs` at 1440 and 390 pixels,
with light/dark schemes and black/white accents, retaining production CSP.
