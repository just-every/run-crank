import { now, stmt, type CrankEnv } from '../model'
import { StepError } from './errors'

/** One durable slot per graph path, including expanded loop children. Resumes do not spend it twice. */
export async function admitStep(env: CrankEnv, runId: string, path: string, ceiling: number) {
  const results = await env.DB.batch([
    stmt(env, `INSERT INTO crank_step_admissions(run_id,path,admitted_at)
      SELECT ?,?,? WHERE (SELECT COUNT(*) FROM crank_step_admissions WHERE run_id=?)<?
      ON CONFLICT(run_id,path) DO NOTHING`, runId, path, now(), runId, ceiling),
    stmt(env, 'SELECT path FROM crank_step_admissions WHERE run_id=? AND path=?', runId, path),
  ])
  if (!results[1].results.length) throw new StepError('validation', 'Per-run step ceiling exhausted; no further step was dispatched', { outcome: 'step ceiling exhausted' })
}
