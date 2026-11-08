import { fields, SettingsError } from './types.ts';
import type { BusinessManifest, SettingsDocument, Trust } from './types.ts';
import { isBusinessTeamRole } from './role-domain.mjs';

export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(): never { throw new SettingsError('invalid_settings'); }
export function closed(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
  return value;
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const email = (value: unknown): value is string => text(value, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value === value.toLowerCase();
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export function validateValues(value: unknown): SettingsDocument['values'] {
  const values = closed(value, [], ['display_name', 'owner_name', 'brand_color', 'timezone']);
  for (const [key, item] of Object.entries(values)) {
    if (!text(item, key === 'timezone' ? 100 : 120)) fail();
    if (key === 'brand_color' && !/^#[0-9a-f]{6}$/i.test(item)) fail();
    if (key === 'timezone') { try { new Intl.DateTimeFormat('en', { timeZone: item }); } catch { fail(); } }
  }
  return values as SettingsDocument['values'];
}
export function manifest(value: BusinessManifest): BusinessManifest {
  const block = closed(value, ['settings', 'values'], ['team']);
  if (block.settings !== 1 || !Array.isArray(block.values) || !block.values.includes('display_name') || new Set(block.values).size !== block.values.length || block.values.some(v => !fields.includes(v))) fail();
  if (block.team !== undefined) {
    const roles = closed(closed(block.team, ['roles']).roles, ['admin', 'member']);
    if (Object.values(roles).some(role => !isBusinessTeamRole(role))) fail();
  }
  return value;
}
export function trust(input: string | Trust): Trust {
  try {
    const value = closed(typeof input === 'string' ? JSON.parse(input) : input, ['v', 'issuer', 'audience', 'subject', 'keys'], ['email']);
    if (value.v !== 1 || !text(value.issuer, 256) || new URL(value.issuer).origin !== value.issuer || !text(value.audience, 256) || (value.audience !== 'self-host' && new URL(value.audience).origin !== value.audience) || !text(value.subject, 256) || (value.email !== undefined && !email(value.email)) || !object(value.keys) || !Object.keys(value.keys).length) fail();
    for (const [kid, item] of Object.entries(value.keys)) {
      if (!text(kid, 128) || !object(item) || item.kty !== 'EC' || item.crv !== 'P-256' || !text(item.x, 64) || !text(item.y, 64) || Object.hasOwn(item, 'd')) fail();
    }
    return value as unknown as Trust;
  } catch { throw new SettingsError('invalid_trust', 503); }
}
export function payload(value: unknown, config: Trust, ownerEmail: string | null): SettingsDocument {
  const p = closed(value, ['v', 'iss', 'aud', 'sub', 'business', 'email', 'jti', 'iat', 'exp', 'rev', 'values', 'logo', 'team'], ['owner_id', 'detached']);
  const now = Math.floor(Date.now() / 1000);
  if (p.v !== 1 || p.iss !== config.issuer || p.aud !== config.audience || p.sub !== config.subject || !email(p.email) || p.email !== (config.email ?? ownerEmail) || (ownerEmail && p.email !== ownerEmail) || !text(p.business, 256) || !text(p.jti, 256) || !integer(p.iat) || !integer(p.exp) || p.iat > now + 30 || p.exp <= now || p.exp <= p.iat || p.exp - p.iat > 86400 || typeof p.rev !== 'number' || !Number.isSafeInteger(p.rev) || (p.detached !== undefined && p.detached !== true)) fail();
  if (Object.hasOwn(p, 'owner_id') && !identity(p.owner_id)) fail();
  validateValues(p.values);
  if (p.logo !== null) {
    const logo = closed(p.logo, ['sha256', 'type', 'bytes']);
    if (typeof logo.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(logo.sha256) || !['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(logo.type as string) || !integer(logo.bytes) || logo.bytes < 1 || logo.bytes > 256 * 1024) fail();
  }
  if (p.team !== null) {
    if (!Array.isArray(p.team) || p.team.length > 500) fail();
    const emails = new Set(), ids = new Set();
    for (const item of p.team) {
      const member = closed(item, ['email', 'name', 'role', 'invite'], ['id']);
      if (!email(member.email) || !text(member.name, 120) || !['admin', 'member'].includes(member.role as string) || !integer(member.invite) || emails.has(member.email)) fail();
      if (Object.hasOwn(member, 'id')) {
        if (!identity(member.id) || ids.has(member.id) || member.id === p.owner_id) fail();
        ids.add(member.id);
      }
      emails.add(member.email);
    }
  }
  return p as unknown as SettingsDocument;
}
