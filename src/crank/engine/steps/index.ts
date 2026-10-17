import { fileFetch } from '../../connectors/files'
import { httpRequest } from '../../connectors/http-step'
import { slackSteps } from '../../connectors/slack'
import type { StepType } from '../types'
import { filter, map, respond, transform } from './core'
import { approval, delay, waitForCallback } from './flow'

/** Every step a published version may declare; `paths` groups are handled by the executor. */
export const STEP_TYPES: Record<string, StepType> = {
  filter, transform, map, respond, delay, wait_for_callback: waitForCallback, approval,
  http: httpRequest, 'file.fetch': fileFetch, ...slackSteps,
}
