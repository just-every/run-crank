# Installed loader mechanism inspected before editing

Vite 8.2.2 node_modules/vite/dist/node/chunks/node.js:
- normalizeResolvedIdToUrl at 27937 strips the project root from an inside-root filename, yielding /agent-surface.json.
- importAnalysisPlugin at 28155 inserts fsPathFromUrl(stripBase(url, base)) into safeModulePaths, retaining that URL-derived string.
- loadAndTransform at 20610/20627 receives the resolved absolute filename and only reads it when isFileLoadingAllowed succeeds.
- isFileLoadingAllowed at 20501 tests strict mode, deny, safeModulePaths.has(filePath), and then explicit fs.allow. Deny is checked before allow.
- CloudflareDevEnvironment.fetchModule at @cloudflare/vite-plugin/dist/index.mjs:65756 delegates this ordinary JSON module to Vite super.fetchModule.

Historical report-only observing load hook returned no replacement result. Its immutable observation records the real JSON exists with SHA-256 05856b153904d58868ef2703b4073c7a7d1e66dd701df4fef5f27ba53396e983, safeManifestEntries=[/agent-surface.json], safeAbsolute=false, absoluteAllowed=false. Existing explicit fs.allow covers src, public, node_modules and deploy-site.json. This installed code matches that trace; the mandatory unchanged shard still determines whether editing is authorized here.
