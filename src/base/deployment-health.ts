// rer deploy compares this body with what it just deployed
// (modules/deploy-kit/health-request.mjs). The deploy kit sets the bindings.
type DeploymentBindings = { RER_DEPLOY_SOURCE?: string, RER_DEPLOY_FINGERPRINT?: string, RER_VERSION?: { id: string } }

/** The /health body that proves which deployment answered. Missing bindings are null. */
export function deploymentHealth(env: DeploymentBindings) {
  return {
    ok: true as const,
    deployment: {
      sourceSha: env.RER_DEPLOY_SOURCE ?? null,
      fingerprint: env.RER_DEPLOY_FINGERPRINT ?? null,
      versionId: env.RER_VERSION?.id ?? null,
    },
  }
}
