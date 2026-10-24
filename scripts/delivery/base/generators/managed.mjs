import {artifactFilename, object} from './validation.mjs';

/** Generate rer-managed.yml, a direct caller of the existing trusted-build ABI. */
export function generateManagedWorkflow(input) {
  object(input, 'managed workflow', ['workflowRef', 'artifactFile', 'buildProfile', 'pnpmVersion', 'verificationProfiles']);
  const {workflowRef, artifactFile, buildProfile = 'project', pnpmVersion, verificationProfiles = ['full','visual']} = input;
  if (typeof workflowRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/\.github\/workflows\/trusted-build\.yml@[a-f0-9]{40}$/.test(workflowRef)) throw new Error('workflowRef must pin trusted-build.yml to a full lowercase 40-character commit SHA');
  if (!['project', 'edition'].includes(buildProfile)) throw new Error('Unsupported buildProfile');
  if (!Array.isArray(verificationProfiles) || !verificationProfiles.length || verificationProfiles[0] !== 'full' || new Set(verificationProfiles).size !== verificationProfiles.length || verificationProfiles.some(profile => !['full','visual'].includes(profile))) throw new Error('Invalid verificationProfiles');
  if (pnpmVersion !== undefined && !['8.15.6', '10.12.4'].includes(pnpmVersion)) throw new Error('Unsupported pnpmVersion for the trusted workflow');
  const artifact = artifactFilename(artifactFile);
  // All interpolated values have restrictive alphabets and are quoted as YAML strings.
  return `name: Managed release
on:
  workflow_dispatch:
    inputs:
      installation_id:
        description: RER installation identifier
        required: true
        type: string
      broker_url:
        description: RER management origin
        required: true
        type: string
      environment:
        description: Target environment
        required: true
        default: preview
        type: choice
        options: [preview, production]
      verification_profile:
        description: Verification scope declared by immutable project source
        required: true
        default: full
        type: choice
        options: [${verificationProfiles.join(', ')}]
permissions:
  contents: read
  actions: read
  id-token: write
jobs:
  release:
    uses: '${workflowRef}'
    with:
      installation_id: \${{ inputs.installation_id }}
      broker_url: \${{ inputs.broker_url }}
      environment: \${{ inputs.environment }}
      verification_profile: \${{ inputs.verification_profile }}
      artifact_file: '${artifact}'
      build_profile: '${buildProfile}'
${pnpmVersion === undefined ? '' : `      pnpm_version: '${pnpmVersion}'\n`}`;
}
