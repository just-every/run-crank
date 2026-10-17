// A signed-in operator corrects the name shown for them: at first-run setup
// (/setup) and later from the app's settings. It is not a credential, so no
// fresh proof is needed; the change is fenced to this session and operator version.
import { deny } from '../errors.mjs';
import { requirePost } from '../http.mjs';
import { displayName } from './admin.mjs';

export function displayNameChange({ config, store, clock, authenticate }) {
  return {
    async changeDisplayName(request, input) {
      requirePost(request, config);
      const actor = await authenticate(request);
      if (!actor) deny('unauthenticated', 401);
      const name = displayName(input?.displayName);
      if (name !== actor.operator.displayName) {
        const fence = store.actorFence(actor, clock());
        const [changed] = await store.batch([[`UPDATE oa_operators SET display_name=? WHERE id=? AND version=? AND ${fence.sql} RETURNING id`, [name, actor.operator.id, actor.operator.version, ...fence.args]]]);
        if (!changed.results.some(row => row.id === actor.operator.id)) deny('authority_changed', 409);
      }
      return store.operator(actor.operator.id);
    },
  };
}
