import type { ToolDefinition } from '../../modules/agent-door/types.ts'
import type { CrankEnv } from '../model.ts'
import surface from '../../../agent-surface.json'
import { metadataTools } from './tool-metadata.ts'
import { workflowTools } from './tool-workflows.ts'

export type DocumentedTool = ToolDefinition & Pick<typeof surface.tools[number], 'job' | 'classificationTests'>

/** Documentation metadata accompanies the admitted operations, never the proposed full surface. */
export function crankTools(env: CrankEnv): DocumentedTool[] {
  return [...workflowTools(env), ...metadataTools(env)].map(tool => {
    const declared = surface.tools.find(item => item.name === tool.name)
    if (!declared || tool.classes.some(cls => !declared.classificationTests.some(test => test.class === cls && test.cases.length))) {
      throw new TypeError(`Missing classification documentation: ${tool.name}`)
    }
    return { ...tool, job: declared.job, classificationTests: declared.classificationTests }
  })
}
