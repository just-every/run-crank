import { aiClassify } from './ai'
import { orbitSteps } from '../../connectors/orbit'
import { digestSteps } from './digest'
import { nookSendMessage } from '../../connectors/nook'
import { driftMap } from '../../agents/drift-step'
import { tableAtomic, tableLookup } from '../../tables/state'
import { subflow } from '../../workflows/subflows'
import { collect } from './collect'
import { customRequest } from '../../custom/step'
import { code } from '../../executors/step'
import { fileFetch } from '../../connectors/files'
import { httpRequest } from '../../connectors/http-step'
import { gustoSteps } from '../../providers/gusto'
import { quickbooksSteps } from '../../providers/quickbooks'
import { invoiceOutcome } from '../../providers/invoice-outcome'
import { invoiceFollowup } from '../../providers/invoice-followup'
import { quickbooksVoid } from '../../providers/quickbooks-compensation'
import { slackSteps } from '../../connectors/slack'
import { googleCalendarSteps } from '../../connectors/google-calendar'
import type { StepType } from '../types'
import { filter, map, respond, transform } from './core'
import { approval, delay, waitForCallback } from './flow'
import { join } from './join'

/** Every step a published version may declare; `paths` groups are handled by the executor. */
export const STEP_TYPES: Record<string, StepType> = {
  'ai.classify': aiClassify, ...orbitSteps, 'nook.send_message': nookSendMessage, 'quickbooks.followup_invoice': invoiceFollowup,
  'drift.map': driftMap, 'table.atomic': tableAtomic, 'table.lookup': tableLookup, subflow, collect, 'custom.request':customRequest, code, filter, transform, map, respond, delay, wait_for_callback: waitForCallback, approval, join,
  'quickbooks.invoice_outcome': invoiceOutcome, http: httpRequest, 'file.fetch': fileFetch, ...digestSteps, ...slackSteps, ...googleCalendarSteps, ...quickbooksSteps, ...gustoSteps, 'quickbooks.void_invoice': quickbooksVoid,
}
