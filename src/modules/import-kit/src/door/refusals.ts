import { ReaderError } from '../readers/errors.ts';
import { CredentialError, credentialFieldText } from '../provenance/credentials.ts';
import { PlanTooLargeError } from '../plan/size.ts';
import { DoorError } from './protocol.ts';

/** Why the reader or a bundle check refused an upload, by kit code. */
const reasons: Record<string, string> = {
  MALFORMED_JSON: 'The upload is not valid JSON in the declared format.',
  MALFORMED_UTF8: 'The upload is not valid UTF-8.',
  INVALID_OR_CREDENTIAL_SOURCE_DATA: 'A source value is not plain JSON data, holds a URL that cannot be parsed, or is encoded too deeply to inspect for credentials.',
  SOURCE_PARSER_FAILED: "The seed's parser refused a source value.",
  SOURCE_OBJECT_DROPPED: "The seed's parser returned no record for a source value.",
  INVALID_PARSED_RECORDS: "The seed's parser returned an invalid record list.",
  INVALID_PARSED_RECORD: "The seed's parser returned an invalid record.",
  INVALID_PARSED_RECORD_ID: "The seed's parser returned a record without a valid kind or source id.",
  INVALID_SOURCE_POINTER: "The seed's parser returned an invalid JSON pointer.",
  INVALID_SOURCE_ID: 'The upload name is not a valid source name.',
  SOURCE_BYTE_LIMIT: 'The upload exceeds the byte limit.',
  SOURCE_RECORD_LIMIT: 'The upload holds more records than the limit.',
  SOURCE_RECORD_BYTE_LIMIT: 'A source record exceeds the per-record byte limit.',
  DUPLICATE_SOURCE_CONFLICT: 'Two source records share a kind and source id but differ.',
  DUPLICATE_TARGET: 'Two source records map to the same native target.',
  SOURCE_EFFECT_LIMIT: 'One source record maps to more than 1,000 native effects.',
  ACTIVE_EFFECT_FORBIDDEN: 'The mapping proposed an active native effect (a grant, job, session or enabled account).',
  INVALID_MAPPING: "The seed's mapping returned an invalid result.",
  REJECTED_RECORD_HAS_EFFECTS: "The seed's mapping rejected a record and also proposed effects for it.",
  INVALID_JSON: 'A mapped value is not finite JSON.',
  INVALID_ID: 'A mapped native target has no valid kind or id.',
  IMPORT_PLAN_TOO_LARGE: 'The import plan exceeds its size limit.',
};
const tooLarge = new Set(['SOURCE_BYTE_LIMIT', 'SOURCE_RECORD_LIMIT', 'SOURCE_RECORD_BYTE_LIMIT', 'SOURCE_EFFECT_LIMIT', 'IMPORT_PLAN_TOO_LARGE']);
const credentialCodes = new Set(['CREDENTIAL_IN_SOURCE_DATA', 'CREDENTIAL_IN_DURABLE_DATA', 'CREDENTIAL_IN_DURABLE_URL']);

/** A reader or bundle-check refusal as a named 4xx: `source_credential` (422)
 * naming the field kind, `source_<code>` (422), or 413 for a size bound. Details
 * carry a fixed reason and the row/pointer, never a source value. Anything else
 * (an adapter, guard or storage failure) is not a source refusal. */
export function sourceRefusal(error: unknown): DoorError | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = error instanceof ReaderError ? error.code : error instanceof PlanTooLargeError ? error.code : error.message.split(':')[0];
  const field = error instanceof ReaderError ? error.field : error instanceof CredentialError ? credentialFieldText(error.field) : undefined;
  const location = error instanceof ReaderError ? error.diagnostics[0]?.location : undefined;
  const at = {...(location?.row !== undefined ? {row: location.row} : {}), ...(location?.pointer !== undefined ? {pointer: location.pointer} : {})};
  if (field !== undefined && (credentialCodes.has(code) || code === 'INVALID_OR_CREDENTIAL_SOURCE_DATA')) {
    return new DoorError('source_credential', 422, {field,
      reason: `The upload holds a credential the door cannot remove: a ${field}. Remove it and upload again.`, ...at});
  }
  if (!(error instanceof ReaderError) && !Object.hasOwn(reasons, code)) return undefined;
  const reason = reasons[code] ?? `The reader refused the upload (${code}).`;
  return new DoorError('source_' + code.toLowerCase().replace(/^source_/, ''), tooLarge.has(code) ? 413 : 422, {reason, ...at});
}
