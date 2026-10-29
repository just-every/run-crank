Vendored yaml 2.9.1 browser ESM distribution.
Upstream: https://github.com/eemeli/yaml/tree/v2.9.1/browser
Package: https://registry.npmjs.org/yaml/-/yaml-2.9.1.tgz
License: ISC (LICENSE).

Portable CLI packaging changes: .js filenames and relative import links use
.mjs, making the module format explicit in every adopting package scope.
Upstream development ESLint directives are removed. Narrow inline annotations
identify intentional YAML control-character grammar, short-circuit parser
operations, scanner loops and callback interface parameters. Parser logic is
unchanged. These annotations apply only to the vendored upstream implementation.
