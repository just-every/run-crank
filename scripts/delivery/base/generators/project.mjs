import {artifactFilename, object, sourceRepository, string} from './validation.mjs';

function profiles(value) {
  object(value, 'verificationProfiles', ['schema', 'visual']);
  if (value.schema !== 1) throw new Error('verificationProfiles schema must be 1');
  const result = {schema: 1};
  if (Object.hasOwn(value, 'visual')) {
    object(value.visual, 'verificationProfiles.visual', ['command']);
    result.visual = {command: string(value.visual.command, 'visual command', 2000)};
  }
  return result;
}

function policy(value) {
  const keys = ['sensitivePaths', 'migrationDirectories', 'guidanceFiles', 'testPatterns'];
  object(value, 'verification', keys);
  const result = {};
  for (const key of Object.keys(value)) {
    const items = value[key];
    // These are the existing service verification policy pattern rules. Preserve
    // all accepted bytes, ordering and duplicates; defaults belong to the service.
    if (!Array.isArray(items) || Object.keys(items).length !== items.length || items.length > 200 || items.some(item => typeof item !== 'string' || !item || item.length > 300 || !/^[A-Za-z0-9._\-/*{},?@+]+$/.test(item) || item.startsWith('/') || item.split('/').includes('..'))) throw new Error(`Invalid verification.${key}`);
    result[key] = [...items];
  }
  return result;
}

/** Generate rer-project.json source content. Register its committed SHA separately. */
export function generateProjectDescriptor(input) {
  object(input, 'project descriptor', ['schema', 'projectId', 'name', 'sourceRepository', 'license', 'deployment', 'operations', 'verification', 'verifyWorkflow']);
  if (input.schema !== 1) throw new Error('Project descriptor schema must be 1');
  const projectId = string(input.projectId, 'projectId', 160);
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/.test(projectId)) throw new Error('projectId must be a slug or publisher-qualified slug');
  object(input.deployment, 'deployment', ['target', 'artifactFile']);
  object(input.operations, 'operations', ['setup', 'build', 'verify', 'artifact', 'recovery', 'verificationProfiles']);
  const operations = {};
  for (const key of ['setup', 'build', 'verify', 'artifact', 'recovery']) {
    if (['setup', 'artifact'].includes(key) && input.operations[key] === undefined) continue;
    operations[key] = string(input.operations[key], `operations.${key}`, key === 'recovery' ? 4000 : 2000);
  }
  if (Object.hasOwn(input.operations, 'verificationProfiles')) operations.verificationProfiles = profiles(input.operations.verificationProfiles);
  return {
    schema: 1, projectId, name: string(input.name, 'name', 100), sourceRepository: sourceRepository(input.sourceRepository), license: string(input.license, 'license', 200),
    deployment: {target: string(input.deployment.target, 'deployment.target', 100), artifactFile: artifactFilename(input.deployment.artifactFile === undefined ? 'rer-worker-artifact.json' : input.deployment.artifactFile)},
    operations,
    ...(Object.hasOwn(input, 'verification') ? {verification: policy(input.verification)} : {}),
    ...(Object.hasOwn(input, 'verifyWorkflow') ? {verifyWorkflow: string(input.verifyWorkflow, 'verifyWorkflow', 300)} : {}),
  };
}
