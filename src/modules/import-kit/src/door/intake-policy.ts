import { canonicalJson, sha256 } from '../provenance/identity.ts';
import type { IntakeCustody } from '../types.ts';
import type { ImportDoorIntake, IntakeFormat } from './intake/types.ts';
import { DoorError } from './protocol.ts';

const formats: readonly string[] = ['csv', 'ndjson', 'json'];
/** Server configuration only: no executable sanitizer, default fields or normalization. */
export function intakeIdentity(intake: ImportDoorIntake): string {
  if (!intake || Object.keys(intake).some(key => !['formats', 'allow'].includes(key))
    || !Array.isArray(intake.formats) || !intake.formats.length || new Set(intake.formats).size !== intake.formats.length
    || !intake.allow || typeof intake.allow !== 'object' || Array.isArray(intake.allow)
    || Object.keys(intake.allow).some(format => !intake.formats.includes(format as IntakeFormat))) throw new DoorError('invalid_intake_configuration', 503);
  const allow: Record<string, string[]> = {};
  for (const format of intake.formats as readonly IntakeFormat[]) {
    const fields = intake.allow[format];
    if (!formats.includes(format) || !Array.isArray(fields) || new Set(fields).size !== fields.length
      || fields.some(field => typeof field !== 'string' || !field.length || field.length > 1024
        || (format !== 'csv' && (!field.startsWith('/') || /~(?![01])/.test(field))))) throw new DoorError('invalid_intake_configuration', 503);
    allow[format] = [...fields].sort();
  }
  return sha256(canonicalJson({formats: [...intake.formats].sort(), allow}));
}
export function intakeCustody(intake: ImportDoorIntake, format: string | null): IntakeCustody {
  const allowlistSha256 = intakeIdentity(intake);
  if (!format || !intake.formats.includes(format as IntakeFormat)) throw new DoorError('intake_format_refused', 415,
    {reason: 'Declare a supported X-Import-Format; an intake upload is never accepted as raw custody.'});
  return {sanitized: true, allowlistSha256, inputFormat: format as IntakeFormat, custodyFormat: 'ndjson'};
}
export interface IntakeState {complete: boolean; custody: IntakeCustody}
export function intakeState(json: string | null | undefined): IntakeState | undefined {
  if (json == null) return undefined;
  let state: IntakeState;
  try { state = JSON.parse(json); } catch { throw new DoorError('upload_custody_mismatch', 409); }
  const c = state?.custody;
  if (typeof state?.complete !== 'boolean' || !c || c.sanitized !== true || c.custodyFormat !== 'ndjson'
    || !formats.includes(c.inputFormat) || !/^[a-f0-9]{64}$/.test(c.allowlistSha256)) throw new DoorError('upload_custody_mismatch', 409);
  return state;
}
