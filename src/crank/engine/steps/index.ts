import { tableAtomic, tableLookup } from '../../tables/state'
import { subflow } from '../../workflows/subflows'
import { collect } from './collect'
import { customRequest } from '../../custom/step'
import { code } from '../../executors/step'
import { fileFetch } from '../../connectors/files'
import { httpRequest } from '../../connectors/http-step'
import { gustoSteps } from '../../providers/gusto'
import { quickbooksSteps } from '../../providers/quickbooks'
import { quickbooksVoid } from '../../providers/quickbooks-compensation'
import { slackSteps } from '../../connectors/slack'
import type { StepType } from '../types'
import { filter, map, respond, transform } from './core'
import { approval, delay, waitForCallback } from './flow'
import { join } from './join'

/** Every step a published version may declare; `paths` groups are handled by the executor. */
export const STEP_TYPES: Record<string, StepType> = {
  'table.atomic': tableAtomic, 'table.lookup': tableLookup, subflow, collect, 'custom.request':customRequest, code, filter, transform, map, respond, delay, wait_for_callback: waitForCallback, approval, join,
  http: httpRequest, 'file.fetch': fileFetch, ...slackSteps, ...quickbooksSteps, ...gustoSteps, 'quickbooks.void_invoice': quickbooksVoid,
}
