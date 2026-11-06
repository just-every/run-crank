# Installed-loader trace, no repair applied

Installed Vite 8.2.2 dist/node/chunks/node.js:
- normalizeResolvedIdToUrl at 27937 strips config.root from an inside-root resolved file, yielding /agent-surface.json.
- importAnalysisPlugin at 28155 adds fsPathFromUrl(stripBase(url, base)) to safeModulePaths. fsPathFromUrl at 2173 does not prefix the project root for that URL.
- loadAndTransform at 20627 uses the resolved absolute filename and isFileLoadingAllowed before fsp.readFile.
- isFileLoadingAllowed at 20501 checks strict, deny, safeModulePaths.has(filePath), then the explicit fs.allow paths.
- Cloudflare plugin CloudflareDevEnvironment.fetchModule at 65756 delegates ordinary JSON modules to super.fetchModule. Vite fetchModule at 34296 calls environment.transformRequest.

The report-only observing plugin returned no load result and did not modify Vite, configuration, source or safeModulePaths. Its actual ssr load observation found the real JSON present and hash-identical, safeAbsolute=false, safeManifestEntries=["/agent-surface.json"], absoluteAllowed=false, strict=true. All explicit allow paths excluded that root JSON. Private .seed/.rer/export paths remained denied. The real Worker then failed loading that exact absolute JSON module. This provides a specific URL-versus-absolute-path mismatch, beyond merely noticing an allowlist omission. No repair or after proof was performed because the mandatory unchanged shard reproduction had stopped earlier on incomplete setup.
