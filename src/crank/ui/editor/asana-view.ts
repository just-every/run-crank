import type { Step } from '../../engine/types'
import { esc } from '../document'

/** Native lookup boundaries beside the selected step's ordinary input mapping. */
export function asanaSettings(step: Step) {
  if (step.type !== 'asana.find_task') return ''
  const field = (label: string, value: unknown) => `<div class="field"><span class="field-label">${esc(label)}</span><span class="field-value">${esc(value)}</span></div>`
  const sort = step.sort as { field: string; direction: string }
  return `<section class="inspector-block"><h3>Asana task lookup</h3>
    ${field('Access', 'Read only · tasks:read consent')}
    ${field('Result order', `${sort.field} ${sort.direction}`)}
    ${field('No match', step.no_match ?? 'continue')}
    ${field('Multiple matches', step.multi_match ?? 'first')}
    ${field('Result bound', step.limit ?? 100)}
    ${field('Page bound', step.max_pages ?? 20)}
    <p class="inspector-note">Reads task identity, name, completion, due dates and permalink in the selected project. The exact name comparison stays here. Incomplete scans return no search outcome. Connection labels do not verify workspace identity.</p>
  </section>`
}
