import { relative } from 'node:path'
import type { Plugin } from 'vite'
import { buildDocs } from './site'

const moduleId = 'virtual:crank-docs'
const resolvedId = `\0${moduleId}`

/** Compile repository Markdown for both site and Worker builds; no filesystem or parser ships. */
export function docsSite(): Plugin {
  let root = process.cwd()
  return {
    name: 'crank:docs',
    configResolved(config) { root = config.root },
    resolveId(id) { if (id === moduleId) return resolvedId },
    load(id) {
      if (id !== resolvedId) return
      const site = buildDocs(root)
      for (const file of site.files) this.addWatchFile(file)
      return `export const docsPages = ${JSON.stringify(site.pages)};\nexport default docsPages;\n`
    },
    handleHotUpdate(context) {
      const path = relative(root, context.file).split('\\').join('/')
      if (!path.startsWith('../') && (path === 'docs/site.json' || path.endsWith('.md'))) {
        const module = context.server.moduleGraph.getModuleById(resolvedId)
        if (module) {
          context.server.moduleGraph.invalidateModule(module)
          context.server.ws.send({ type: 'full-reload' })
          return []
        }
      }
    },
  }
}
