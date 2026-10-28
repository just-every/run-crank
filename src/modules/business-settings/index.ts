import { ink } from '../../foundation/runtime/theme-frame.ts';
import { apply } from './apply.ts';
import { base64, checkedLogo, imageType, logoHeaders } from './logo.ts';
import { settingsRow, snapshot } from './store.ts';
import { closed, manifest, trust, validateValues } from './validation.ts';
import { verify } from './verify.ts';
import { fields, SettingsError } from './types.ts';
import { parseJson } from './json.ts';
import type { Field, Guard, Logo, Options } from './types.ts';
export type * from './types.ts';

const noStore = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
async function body(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > 512 * 1024) throw new SettingsError('body_too_large', 413);
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new SettingsError('invalid_settings');
  const reader = request.body?.getReader();
  if (!reader) throw new SettingsError('invalid_settings');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) { await reader.cancel(); throw new SettingsError('body_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return closed(parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ['settings'], ['logo']); }
  catch { throw new SettingsError('invalid_settings'); }
}

/** Construct per request, or retain for the Worker's lifetime: all values come from D1. */
export function createBusinessSettings(options: Options) {
  manifest(options.business);
  const config = options.trust ? trust(options.trust) : null;
  const { db, business } = options;
  async function read() { return snapshot(db); }
  async function override(field: Field): Promise<{value: string} | null> {
    return db.prepare('SELECT value FROM bs_overrides WHERE field=?').bind(field).first<{value: string}>();
  }
  async function resolve(field: Field, seedValue: unknown): Promise<unknown> {
    if (!fields.includes(field)) throw new SettingsError('invalid_field', 400);
    const local = await override(field);
    if (local) {
      const value: unknown = JSON.parse(local.value);
      if (field === 'logo' && value) { const { data: _data, ...logo } = value as Logo & {data: string}; return logo; }
      return value;
    }
    if (!business.values.includes(field)) return seedValue;
    const state = await read();
    if (!state.document) return seedValue;
    return field === 'logo' ? state.document.logo : state.document.values[field] ?? seedValue;
  }
  async function setOverride(field: Field, value: unknown, actor: string): Promise<void> {
    if (!fields.includes(field) || !business.values.includes(field)) throw new SettingsError('invalid_field', 400);
    if (typeof actor !== 'string' || !actor.trim() || actor.length > 254) throw new SettingsError('actor_required', 400);
    if (field === 'logo') {
      if (value !== null) {
        const logo = closed(value, ['sha256', 'type', 'bytes', 'data']);
        await checkedLogo(logo.data, logo as unknown as Logo);
      }
    } else validateValues({ [field]: value });
    const now = new Date().toISOString();
    await db.batch([
      db.prepare('INSERT INTO bs_overrides(field,value,actor,changed_at) VALUES(?,?,?,?) ON CONFLICT(field) DO UPDATE SET value=excluded.value,actor=excluded.actor,changed_at=excluded.changed_at').bind(field, JSON.stringify(value), actor, now),
      db.prepare("INSERT INTO bs_audit(actor,action,field,changed_at) VALUES(?,'override',?,?)").bind(actor, field, now),
    ]);
  }
  async function clearOverride(field: Field, actor: string): Promise<void> {
    if (!fields.includes(field) || typeof actor !== 'string' || !actor.trim() || actor.length > 254) throw new SettingsError('invalid_override', 400);
    await db.batch([
      db.prepare('DELETE FROM bs_overrides WHERE field=?').bind(field),
      db.prepare("INSERT INTO bs_audit(actor,action,field,changed_at) VALUES(?,'clear_override',?,?)").bind(actor, field, new Date().toISOString()),
    ]);
  }
  async function stop(actor: string, guard: Guard = { sql: '1', args: [] }): Promise<void> {
    if (typeof actor !== 'string' || !actor.trim() || actor.length > 254) throw new SettingsError('actor_required', 400);
    await db.batch([
      db.prepare('INSERT INTO bs_settings(singleton) VALUES(1) ON CONFLICT(singleton) DO NOTHING'),
      db.prepare(`UPDATE bs_settings SET stopped=1 WHERE singleton=1 AND ${guard.sql}`).bind(...guard.args),
      db.prepare(`INSERT INTO bs_audit(actor,action,changed_at) SELECT ?,'stopped',? WHERE ${guard.sql}`).bind(actor, new Date().toISOString(), ...guard.args),
      db.prepare(`INSERT INTO bs_assert(value) VALUES(CASE WHEN ${guard.sql} THEN 1 ELSE NULL END)`).bind(...guard.args),
      db.prepare('DELETE FROM bs_assert'),
    ]);
  }
  async function publicBrand(): Promise<{displayName?: string; logo?: string}> {
    const [displayName, logo] = await Promise.all([resolve('display_name', undefined), resolve('logo', null)]);
    return { ...(typeof displayName === 'string' ? { displayName } : {}), ...(logo ? { logo: `/rer-business-logo?v=${(logo as Logo).sha256.slice(0, 12)}` } : {}) };
  }
  async function logoResponse(request: Request): Promise<Response> {
    const local = await override('logo');
    const localLogo = local ? JSON.parse(local.value) as (Logo & {data: string}) | null : undefined;
    const row = local ? null : await db.prepare('SELECT sha256,type,bytes FROM bs_logo WHERE singleton=1').first<{sha256: string; type: string; bytes: ArrayBuffer}>();
    const logo = local ? localLogo : row;
    if (!business.values.includes('logo') || !logo) return new Response('Not found', { status: 404, headers: noStore });
    const version = new URL(request.url).searchParams.get('v');
    if (version !== null && version !== logo.sha256.slice(0, 12)) return new Response('Not found', { status: 404, headers: noStore });
    const bytes = localLogo ? base64(localLogo.data) : new Uint8Array(row!.bytes);
    if (imageType(bytes) !== logo.type) throw new SettingsError('invalid_logo', 400);
    const headers = logoHeaders(logo.type, logo.sha256, version !== null);
    if (request.headers.get('if-none-match') === headers.etag) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : bytes, { headers });
  }
  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url), path = url.pathname;
    if (!['/api/rer/business-settings', '/rer-business-logo', '/rer-business.css'].includes(path)) return null;
    try {
      if (path === '/api/rer/business-settings') {
        if (!config || (await settingsRow(db))?.stopped) return new Response('Not found', { status: 404, headers: noStore });
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...noStore, allow: 'POST' } });
        if (config.audience !== 'self-host' && url.origin !== config.audience) throw new SettingsError('invalid_settings');
        const envelope = await body(request);
        const ownerEmail = await options.team?.ownerEmail?.() ?? null;
        const document = await verify(envelope.settings, config, ownerEmail);
        return await apply(options, document, envelope.logo);
      }
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...noStore, allow: 'GET, HEAD' } });
      if (path === '/rer-business-logo') return await logoResponse(request);
      const state = await read(), color = await resolve('brand_color', null);
      // Overrides can change independently of the platform revision.
      const etag = `"${state.rev}-${typeof color === 'string' ? color.slice(1) : 'none'}"`;
      const headers = { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=60', etag, 'x-content-type-options': 'nosniff' };
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
      return new Response(request.method === 'HEAD' ? null : typeof color === 'string' ? `:root{--rer-business-accent:${color};--rer-business-accent-text:${ink(color)}}` : '', { headers });
    } catch (error) {
      if (!(error instanceof SettingsError)) return Response.json({ error: 'settings_unavailable' }, { status: 503, headers: noStore });
      return Response.json({ error: error.code }, { status: error.status, headers: noStore });
    }
  }
  return { handle, read, resolve, setOverride, clearOverride, stop, publicBrand };
}
