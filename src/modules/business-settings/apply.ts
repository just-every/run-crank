import { checkedLogo } from './logo.ts';
import { ack, initialSettings, managed, settingsRow, snapshot } from './store.ts';
import { SettingsError } from './types.ts';
import { projectManaged, teamRows } from './team.ts';
import type { Options, SettingsDocument } from './types.ts';

/** The accepted revision and every native team write commit in one D1 transaction. */
export async function apply(options: Options, document: SettingsDocument, suppliedLogo: unknown): Promise<Response> {
  const { db, business } = options;
  const before = await settingsRow(db) ?? initialSettings();
  if (before.stopped) throw new SettingsError('not_found', 404);
  if (document.rev <= before.rev) return Response.json(ack(await snapshot(db), business), { status: 409, headers: { 'cache-control': 'no-store' } });
  if (before.document && (JSON.parse(before.document) as SettingsDocument).business !== document.business) throw new SettingsError('business_binding_mismatch');
  if (before.owner_id && document.owner_id && before.owner_id !== document.owner_id) throw new SettingsError('business_owner_binding_mismatch');
  const ownerId = document.owner_id ?? before.owner_id;
  const storedTeam = await managed(db);
  if (ownerId && storedTeam.some(row => row.businessId === ownerId)) throw new SettingsError('business_owner_binding_mismatch');
  const oldLogo = await db.prepare('SELECT sha256 FROM bs_logo WHERE singleton=1').first<{sha256: string}>();
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  if (!document.detached && document.logo) {
    if (suppliedLogo !== undefined) bytes = await checkedLogo(suppliedLogo, document.logo);
    else if (oldLogo?.sha256 !== document.logo.sha256) throw new SettingsError('logo_required', 400);
  } else if (suppliedLogo !== undefined) throw new SettingsError('unexpected_logo', 400);
  const now = new Date().toISOString(), token = crypto.randomUUID();
  const guard = { sql: 'EXISTS(SELECT 1 FROM bs_settings WHERE singleton=1 AND rev=? AND token=? AND stopped=0)', args: [document.rev, token] };
  const fence = document.detached ? { sql: 'EXISTS(SELECT 1 FROM bs_settings WHERE singleton=1 AND rev=? AND token=?)', args: guard.args } : guard;
  const statements = [db.prepare('INSERT INTO bs_settings(singleton) VALUES(1) ON CONFLICT(singleton) DO NOTHING'),
    db.prepare(`UPDATE bs_settings SET rev=?,document=?,applied_at=?,stopped=?,token=?,owner_id=? WHERE singleton=1 AND stopped=0 AND rev=?`)
    .bind(document.rev, document.detached ? before.document : JSON.stringify(document), now, document.detached ? 1 : 0, token, document.detached ? before.owner_id : ownerId, before.rev)];
  if (!document.detached && business.values.includes('logo')) {
    if (!document.logo) statements.push(db.prepare(`DELETE FROM bs_logo WHERE ${guard.sql}`).bind(...guard.args));
    else if (bytes) statements.push(db.prepare(`INSERT INTO bs_logo(singleton,sha256,type,bytes) SELECT 1,?,?,? WHERE ${guard.sql}
      ON CONFLICT(singleton) DO UPDATE SET sha256=excluded.sha256,type=excluded.type,bytes=excluded.bytes`)
      .bind(document.logo.sha256, document.logo.type, bytes, ...guard.args));
  }
  const projected = !document.detached && document.team !== null ? projectManaged(storedTeam, document.team, ownerId) : storedTeam;
  const team = !document.detached && document.team !== null && business.team && options.team
    ? await options.team.prepare({ members: document.team, managed: projected, ownerEmail: document.email, roles: business.team.roles, guard }) : null;
  if (!document.detached && document.team !== null && business.team && !options.team) throw new SettingsError('team_adapter_required', 503);
  if (team) {
    statements.push(...team.statements);
    statements.push(db.prepare(`DELETE FROM bs_team WHERE ${guard.sql}`).bind(...guard.args));
    for (const row of teamRows(team.rows, document.team!, projected)) statements.push(db.prepare(`INSERT INTO bs_team(email,operator_id,invite,state,business_id,business_role) SELECT ?,?,?,?,?,? WHERE ${guard.sql}`)
      .bind(row.email, row.operatorId ?? null, row.invite, row.state, row.businessId, row.businessRole, ...guard.args));
  }
  statements.push(db.prepare(`INSERT INTO bs_audit(actor,action,changed_at) SELECT ?,?,? WHERE ${fence.sql}`)
    .bind(document.email, document.detached ? 'detached' : 'applied', now, ...fence.args));
  statements.push(db.prepare(`INSERT INTO bs_assert(value) VALUES(CASE WHEN ${fence.sql} THEN 1 ELSE NULL END)`).bind(...fence.args));
  statements.push(db.prepare('DELETE FROM bs_assert'));
  try { await db.batch(statements); }
  catch (error) {
    const current = await settingsRow(db);
    if (current?.stopped) throw new SettingsError('not_found', 404);
    if (current && current.rev >= document.rev) return Response.json(ack(await snapshot(db), business), { status: 409, headers: { 'cache-control': 'no-store' } });
    throw error;
  }
  try { await team?.afterCommit(); }
  catch { throw new SettingsError('invitation_delivery_failed', 503); }
  return Response.json(ack(await snapshot(db), business), { headers: { 'cache-control': 'no-store' } });
}
