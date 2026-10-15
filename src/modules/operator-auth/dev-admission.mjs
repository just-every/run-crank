// A dev session, and any credential minted while using one, counts only on a
// request that passes the local key gate. Only the local-only dev layer
// (./dev/) registers that check. A production Worker never loads the layer, so
// every dev credential is refused there.
let admission = null;
export function registerDevAdmission(check) { admission = typeof check === 'function' ? check : null; }
export async function devAdmitted(request) {
  if (!admission) return false;
  try { return (await admission(request)) === true; } catch { return false; }
}
