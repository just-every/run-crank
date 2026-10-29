# Policy source provenance

Ported from the reviewed, read-only policy snapshot at commit
`72aa71c03d943b53ed43dc73cac17d412c00d8fb`.
The original source paths and SHA-256 hashes are:

- `src/business/agent-policy/catalogue.ts`: `7c15685b0f2a308da0cc6645f066dd8e64948c1da582550b387f69c230f8d179`
- `src/business/agent-policy/document.ts`: `20dfabffbdbb5594b0a5194374d8054ab75fb09ef2cb799939eb56faf324edd6`
- `src/business/agent-policy/decide.ts`: `67ac665391facd7fd11941242bd8a77271a6ff7446f552ad412467cd33ebe9eb`

The only source edits are explicit `.ts` extensions on relative imports in
`document.ts` and `decide.ts`, and expansion of the `DocumentInvalid` constructor
parameter property into an explicit readonly property and assignment. Policy
behavior, the eleven classes, validation and decision precedence are unchanged.

`SHA256SUMS` records the actual hashes of the three ported files in this directory.
