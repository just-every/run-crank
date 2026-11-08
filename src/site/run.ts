import { runPricing } from '../base/run-pricing'
import type { RunData } from '../base/run-site'
import data from './run.json'

export const run: RunData = { ...data, pricing: runPricing }
