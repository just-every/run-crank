/** Pure archive checks shared by CLI and browser restoration. No credentials or
 * provider requests are consulted while the receiving installation is inactive. */
export function validAsanaGraph(steps) {
  if (!Array.isArray(steps)) return false;
  return steps.every(step => {
    if (!step || typeof step !== 'object') return false;
    if (step.type === 'asana.find_task') {
      const input = step.input;
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['project_id','name'].includes(key)) ||
          typeof input.project_id !== 'string' || !/^[1-9][0-9]{0,39}$/.test(input.project_id) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 8192 || /[\x00-\x1f\x7f]/.test(input.name) ||
          typeof step.connection_id !== 'string' || !step.connection_id.trim() || step.connection_id.includes('{{') || step.create_if_not_found !== undefined ||
          !step.sort || step.sort.field !== 'id' || !['asc','desc'].includes(step.sort.direction) ||
          step.max_pages !== undefined && (!Number.isInteger(step.max_pages) || step.max_pages < 1 || step.max_pages > 20) ||
          step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || step.timeout_ms < 100 || step.timeout_ms > 30000)) return false;
    }
    return (!step.steps || validAsanaGraph(step.steps)) && (!step.branches || Array.isArray(step.branches) && step.branches.every(branch => validAsanaGraph(branch.steps))) &&
      (!step.fallback || validAsanaGraph(step.fallback.steps)) && (!step.always || validAsanaGraph(step.always.steps));
  });
}
