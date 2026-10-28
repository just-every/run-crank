import type { Ack, Database, BusinessManifest, Field, ManagedMember, SettingsDocument, Snapshot } from './types.ts';

export interface SettingsRow { rev: number; document: string | null; applied_at: string | null; stopped: number; token: string; owner_id: string | null }
export const initialSettings = (): SettingsRow => ({ rev: 0, document: null, applied_at: null, stopped: 0, token: '', owner_id: null });
export function settingsRow(db: Database): Promise<SettingsRow | null> {
  return db.prepare('SELECT rev,document,applied_at,stopped,token,owner_id FROM bs_settings WHERE singleton=1').first<SettingsRow>();
}
export async function managed(db: Database): Promise<ManagedMember[]> {
  return (await db.prepare('SELECT email,operator_id AS operatorId,invite,state,business_id AS businessId,business_role AS businessRole FROM bs_team ORDER BY email').all<ManagedMember>()).results;
}
export async function snapshot(db: Database): Promise<Snapshot> {
  const [stored, overrides, team, logo] = await Promise.all([
    settingsRow(db), db.prepare('SELECT field,value FROM bs_overrides ORDER BY field').all<{field: Field; value: string}>(),
    managed(db), db.prepare('SELECT sha256 FROM bs_logo WHERE singleton=1').first<{sha256: string}>(),
  ]);
  const row = stored ?? initialSettings();
  const localLogo = overrides.results.find(r => r.field === 'logo');
  return { document: row.document ? JSON.parse(row.document) as SettingsDocument : null, rev: row.rev, appliedAt: row.applied_at,
    stopped: !!row.stopped, overrides: overrides.results.map(r => r.field), logo: localLogo ? (JSON.parse(localLogo.value) as {sha256: string} | null)?.sha256 ?? null : logo?.sha256 ?? null,
    team: team.map(({ email, state }) => ({ email, state })) };
}
export function ack(state: Snapshot, business: BusinessManifest): Ack {
  return { rev: state.rev, applied: state.document ? business.values.filter(f => !state.overrides.includes(f) && (f === 'logo' || Object.hasOwn(state.document!.values, f))) : [],
    overrides: state.overrides, logo: state.logo, team: state.team };
}
