Babel parser 7.29.8 and its string/identifier helpers (MIT; LICENSE).
Source: https://github.com/babel/babel/tree/v7.29.8/packages/babel-parser/src
Helpers: packages/babel-helper-string-parser/src and
packages/babel-helper-validator-identifier/src in that same release.

The 45 upstream TypeScript modules retain their source boundaries as explicit
.mjs modules. Compilation uses @babel/core and @babel/preset-typescript 7.29.7,
onlyRemoveTypeImports and optimizeConstEnums, the release's official bit-decorator
plugin and babel-plugin-transform-charcodes 0.2.1. Babel 7 production flags are
folded (BABEL_8_BREAKING=false, IS_PUBLISH=true, NODE_ENV=production), then esbuild
emits Node 22 ESM. Relative imports and the two helper-package imports point to
these local modules. No runtime package installation is required.

The source files were checked against the Git blob identifiers in the official
v7.29.8 tree. Compiled ASTs were compared with the published @babel/parser 7.29.8
for JavaScript, optional calls, templates, TypeScript and TSX. Parser behavior is
unchanged; runtime dependency policy is in ../../module-edges.mjs.

Grammar fallthrough and empty-probe comments are restored for linting. Narrow
inline unused-binding annotations preserve upstream parser method/callback
interfaces. These annotations apply only to the generated upstream modules.
