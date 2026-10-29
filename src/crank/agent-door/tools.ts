import type { ToolDefinition } from '../../modules/agent-door/types.ts'
import type { CrankEnv } from '../model.ts'
import { metadataTools } from './tool-metadata.ts'
import { workflowTools } from './tool-workflows.ts'

/** Only native preparation and credential-free metadata are admitted by this door. */
export function crankTools(env: CrankEnv): ToolDefinition[] {
  return [...workflowTools(env), ...metadataTools(env)]
}
