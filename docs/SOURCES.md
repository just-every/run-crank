# Foundation and reused source

Crank began with the committed Base foundation at
`fc0e1041efa55771142bbb57c4ab4743147e264d`. `composition.lock.json` records
the generated application runtime and auth copies. `base-copies.json` records
the unchanged import-kit source. The command tooling comes from the exact
published package `@runeditrun/rer@0.2.30`. `base-copies.json` also records the
verbatim Base runtime, installer and workflow copies, refreshed together from
`rer-v0.2.30` (`d434ea67989fe10b6ddff01daba8bb350975e54a`).

Package-mode operation was informed by the public Coaster, Beam and Pier seeds.
No sibling repository was edited. Crank's domain code adapts these MIT patterns:

- [Orbit approval repository](https://github.com/just-every/run-orbit/blob/38cef87571a413802dbaa7aa6afbab332d8cd778/src/core/features/outreach/approval-repository.ts): conditional immutable approval snapshots and idempotency. Used in `src/crank/delivery.ts`.
- [HappyToHelp owned jobs](https://github.com/just-every/run-happytohelp/blob/9941eeadc6deb3ed0f04bd4caed94ee8e3e821ac/src/modules/local-computer/jobs.ts) and [device authorization](https://github.com/just-every/run-happytohelp/blob/9941eeadc6deb3ed0f04bd4caed94ee8e3e821ac/src/modules/local-computer/authorization.ts): scoped hashed grants, atomic claims and lease ownership. Used in `src/crank/access.ts`, `tokens.ts` and `delivery.ts`.
- [Spool admission](https://github.com/just-every/run-spool/blob/9f75f060a66446f4c9dcf9cafddd0906d7698748/src/domain/admission.ts): same-identity/same-digest event admission and authority inside the write transaction. Used in `src/crank/runs.ts` and `access.ts`.
- [Uptime schedule](https://github.com/just-every/run-uptime/blob/c699a67fa0358f79b736c27b7657a9189afaa9f4/src/domain/schedule.ts): bounded acceptance-window calculation used for the delivery lease. Scheduled triggers are outside this release.

Orbit, Spool, Uptime and Base: Copyright (c) 2026 Run Edit Run.
HappyToHelp: Copyright (c) 2026 Peter Industries Pty Ltd as trustee for Peter
Family Trust, trading as JustEvery.

These sources are provided under the MIT License:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Shared process inspection

The exact published RER 0.2.30 package supplies bounded, nonblocking macOS listener ownership inspection. No local RER patches are applied.
