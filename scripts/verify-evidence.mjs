const shaShape = value => /^[a-f0-9]{40}$/.test(value ?? '');
const repositoryShape = value => Number.isSafeInteger(value?.id) && value.id > 0 && typeof value.full_name === 'string';
export const succeeded = value => value?.status === 'completed' && value.conclusion === 'success';
export const runShape = value => Number.isSafeInteger(value?.id) && value.id > 0
 && Number.isSafeInteger(value.workflow_id) && value.workflow_id > 0
 && Number.isSafeInteger(value.run_attempt) && value.run_attempt > 0
 && typeof value.name === 'string' && shaShape(value.head_sha)
 && (typeof value.head_branch === 'string' || value.head_branch === null)
 && typeof value.event === 'string' && typeof value.status === 'string'
 && (typeof value.conclusion === 'string' || value.conclusion === null)
 && repositoryShape(value.repository) && (value.head_repository === null || repositoryShape(value.head_repository));
const jobShape = value => Number.isSafeInteger(value?.id) && value.id > 0 && Number.isSafeInteger(value.run_id)
 && Number.isSafeInteger(value.run_attempt) && typeof value.name === 'string' && typeof value.status === 'string'
 && (typeof value.conclusion === 'string' || value.conclusion === null);

// No partial, duplicated, changing or oversized listing may authorize reuse.
export function githubEvidence(env, fetch = globalThis.fetch) {
 if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')
  || !shaShape(env.GITHUB_SHA) || !env.GITHUB_TOKEN) throw Error('Missing verification identity');
 const origin = new URL(env.GITHUB_API_URL || 'https://api.github.com');
 if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw Error('Invalid API origin');
 const root = `${origin.href.replace(/\/$/, '')}/repos/${env.GITHUB_REPOSITORY}`;
 const signal = AbortSignal.timeout(20000);
 const get = async path => {
  const response = await fetch(`${root}/${path}`, { signal, redirect: 'error', headers: {
   Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28',
  } });
  if (response.status !== 200) throw Error('Verification evidence unavailable');
  return response.json();
 };
 const list = async (path, key, shape) => {
  const items = [];
  for (let page = 1, total; page <= 10; page++) {
   const response = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
   if (!Number.isSafeInteger(response?.total_count) || response.total_count < 0 || response.total_count > 1000
    || (total ?? response.total_count) !== response.total_count || !Array.isArray(response[key])
    || response[key].length !== Math.min(100, response.total_count - items.length) || !response[key].every(shape)) throw Error('Incomplete evidence');
   total = response.total_count;
   items.push(...response[key]);
   if (items.length === total) {
    if (new Set(items.map(item => item.id)).size !== total) throw Error('Duplicated evidence');
    return items;
   }
  }
  throw Error('Evidence pagination limit');
 };
 const run = async id => {
  const result = await get(`actions/runs/${id}`);
  if (!runShape(result) || String(result.id) !== String(id)) throw Error('Invalid run identity');
  return result;
 };
 const sameRepository = (value, current) => value.repository.id === current.repository.id
  && value.repository.full_name === env.GITHUB_REPOSITORY
  && value.head_repository?.id === current.repository.id && value.head_repository.full_name === env.GITHUB_REPOSITORY;
 const eligible = (value, current, sha) => value.id !== current.id && value.workflow_id === current.workflow_id
  && value.name === current.name && value.head_sha === sha && sameRepository(value, current);
 const newest = async (current, sha, qualifies) => (await list(
  `actions/workflows/${current.workflow_id}/runs?head_sha=${sha}`, 'workflow_runs', runShape))
  .filter(value => eligible(value, current, sha) && qualifies(value))
  .reduce((latest, value) => !latest || value.id > latest.id ? value : latest, undefined);
 const proof = async (listed, required) => {
  if (!listed || !succeeded(listed)) return false;
  const latest = await run(listed.id);
  if (latest.run_attempt !== listed.run_attempt || !succeeded(latest) || latest.head_sha !== listed.head_sha
   || latest.event !== listed.event || latest.head_branch !== listed.head_branch
   || latest.workflow_id !== listed.workflow_id || latest.name !== listed.name || !sameRepository(latest, listed)) return false;
  const jobs = await list(`actions/runs/${latest.id}/attempts/${latest.run_attempt}/jobs`, 'jobs', jobShape);
  if (!jobs.length || !jobs.every(job => job.run_id === latest.id && job.run_attempt === latest.run_attempt
   && (succeeded(job) || job.status === 'completed' && job.conclusion === 'skipped'))) return false;
  return required.every(name => jobs.filter(job => job.name === name || job.name.endsWith(` / ${name}`)).length === 1
   && jobs.some(job => (job.name === name || job.name.endsWith(` / ${name}`)) && succeeded(job)));
 };
 return { get, run, newest, proof, sameRepository };
}
