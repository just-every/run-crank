import type { PeopleAdapter } from './types.ts'

/** Only a positively readable, running Business can retain Business authority. */
export async function businessRunning(people: PeopleAdapter): Promise<boolean> {
  try { return typeof people.businessStopped === 'function' && await people.businessStopped() === false }
  catch { return false }
}
