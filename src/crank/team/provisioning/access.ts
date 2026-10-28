import type { Actor } from '../../model'

export function groupRevisionFence(_actor: Actor, revision: string) {
  return {sql:'EXISTS(SELECT 1 FROM crank_scim_revision WHERE singleton=1 AND revision=?)',args:[revision] as unknown[]}
}
