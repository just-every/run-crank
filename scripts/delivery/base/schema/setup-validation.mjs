import { dependencyErrors } from './dependencies.mjs';
export { validateDependencyGraph } from './dependencies.mjs';
import {checkSchema, validate} from './json-schema.mjs';
import {businessFieldInputError} from './business-field-inputs.mjs';

export const SETUP_SCHEMA_ID = 'urn:rer:setup:1';

const PUBLIC_KINDS = new Set(['text', 'email', 'url', 'select', 'colour', 'timezone']);

/** Effective audience of a validated public field, including its group default. */
export function setupFieldAudience(field, groups) {
  return field.audience ?? groups.find(group => group.id === field.group)?.audience ?? 'owner';
}

/** Match a validated condition against raw public input; whitespace is a value. */
export function setupConditionMatches(condition, values) {
  const value = values[condition.field];
  return condition.nonEmpty === true
    ? typeof value === 'string' && value.length > 0
    : value === condition.equals;
}

/** Install-time value validation shared by manifest defaults and consumers. */
export function validateSetupValue(field, value) {
  if (typeof value !== 'string' || value.length > 16384) throw Error(`Invalid setup value for ${field.name}`);
  if (!value) return;
  if (field.kind === 'email') {
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/.test(email)) throw Error(`Invalid email for ${field.name}`);
  }
  if (field.kind === 'url') {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#')) throw Error();
    } catch { throw Error(`Invalid URL for ${field.name}`); }
  }
  if (field.kind === 'colour' && !/^#[a-f\d]{6}$/i.test(value)) throw Error(`Invalid color for ${field.name}`);
  if (field.kind === 'timezone') {
    try { new Intl.DateTimeFormat('en', {timeZone: value}); }
    catch { throw Error(`Invalid timezone for ${field.name}`); }
  }
  if (field.kind === 'select' && !field.options?.some(option => option.value === value)) throw Error(`Invalid selection for ${field.name}`);
}

/** Parse committed manifest bytes strictly, including duplicate object keys. */
export function parseSetupManifestBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Setup manifest input must be bytes');
  let text;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw new Error('Setup manifest must be valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Setup manifest must contain valid JSON');
  }
  rejectDuplicateObjectKeys(text);
  return value;
}

function rejectDuplicateObjectKeys(text) {
  let position = 0;
  const whitespace = () => { while (/\s/.test(text[position] ?? '') && position < text.length) position += 1; };
  function stringToken() {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '\\') position += 1;
      else if (character === '"') return JSON.parse(text.slice(start, position));
    }
    throw new Error('Setup manifest contains an incomplete JSON string');
  }
  function visit() {
    whitespace();
    const opening = text[position];
    if (opening === '"') { stringToken(); return; }
    if (opening !== '{' && opening !== '[') {
      while (position < text.length && !/[\s,}\]]/.test(text[position])) position += 1;
      return;
    }
    position += 1;
    whitespace();
    const closing = opening === '{' ? '}' : ']';
    const names = new Set();
    if (text[position] === closing) { position += 1; return; }
    for (;;) {
      if (opening === '{') {
        whitespace();
        const name = stringToken();
        if (names.has(name)) throw new Error('Setup manifest contains a duplicate JSON field');
        names.add(name);
        whitespace();
        position += 1; // JSON.parse above has already checked the colon.
      }
      visit();
      whitespace();
      const separator = text[position++];
      if (separator === closing) return;
    }
  }
  visit();
}

// Run before grammar diagnostics too, so off-list names receive a useful next step.
function businessFieldErrors(data) {
  const errors = [], claims = new Map();
  for (const [index, field] of (Array.isArray(data?.fields) ? data.fields : []).entries()) {
    if (!field || typeof field.name !== 'string' || !Object.hasOwn(field, 'businessField')) continue;
    const path = `$.fields[${index}].businessField`;
    const refusal = businessFieldInputError(field);
    if (refusal) errors.push(`${path}: ${refusal}`);
    if (typeof field.businessField !== 'string') continue;
    const previous = claims.get(field.businessField);
    if (previous !== undefined) errors.push(`${path}: ${previous} and ${field.name} both claim Business field ${field.businessField}; each Business field needs a single input`);
    else claims.set(field.businessField, field.name);
  }
  return errors;
}

/** Semantic checks that cannot be expressed in the portable JSON Schema subset. */
export function setupManifestSemanticErrors(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !Array.isArray(data.fields) || !Array.isArray(data.groups) || !Array.isArray(data.steps)) return [];
  const errors = [...dependencyErrors(data), ...businessFieldErrors(data)];
  const fail = (path, message) => errors.push(`${path}: ${message}`);
  const groups = new Map();
  for (const [index, group] of data.groups.entries()) {
    if (!group || typeof group !== 'object' || typeof group.id !== 'string') continue;
    if (groups.has(group.id)) fail(`$.groups[${index}].id`, 'group IDs must be unique');
    else groups.set(group.id, group);
  }

  const fields = new Map();
  const fieldIndexes = new Map();
  for (const [index, field] of data.fields.entries()) {
    if (!field || typeof field !== 'object' || typeof field.name !== 'string') continue;
    if (fields.has(field.name)) fail(`$.fields[${index}].name`, 'field names must be unique');
    else {
      fields.set(field.name, field);
      fieldIndexes.set(field.name, index);
    }
  }

  for (const [index, field] of data.fields.entries()) {
    if (!field || typeof field !== 'object' || typeof field.name !== 'string') continue;
    const path = `$.fields[${index}]`;
    const isSecret = field.kind === 'secret';
    if (!isSecret && !PUBLIC_KINDS.has(field.kind)) continue;
    if (field.order !== undefined && field.order < 0) fail(`${path}.order`, 'field order must be zero or greater');
    if (field.group !== undefined && !groups.has(field.group)) fail(`${path}.group`, 'group must reference a declared group');

    if (isSecret) {
      if (Object.hasOwn(field, 'audience')) fail(`${path}.audience`, `${field.name}: secret fields cannot declare audience`);
      for (const name of ['default', 'prefill', 'options', 'runtimeEditable']) {
        if (Object.hasOwn(field, name)) fail(`${path}.${name}`, 'secret fields cannot declare public input metadata');
      }
      if (field.input === 'entered') {
        if (field.ownerVisible !== true) fail(`${path}.ownerVisible`, 'entered secrets must be owner-visible');
        if (field.generate !== undefined) fail(`${path}.generate`, 'entered secrets cannot declare generation');
      } else if (field.input === 'managed' && field.ownerVisible !== false) {
        fail(`${path}.ownerVisible`, 'managed secrets must be hidden from the owner');
      }
      if (field.ownerVisible === true && field.generate === undefined && field.input !== 'entered') {
        fail(`${path}.ownerVisible`, 'only generated or explicitly entered secret values may be shown to the owner');
      }
    } else {
      if (field.audience === 'owner' && groups.get(field.group)?.audience === 'developer') {
        fail(`${path}.audience`, `${field.name} cannot declare owner audience inside developer group ${field.group}`);
      }
      for (const name of ['generate', 'ownerVisible', 'input']) {
        if (Object.hasOwn(field, name)) fail(`${path}.${name}`, 'public fields cannot declare secret metadata');
      }
      if (Object.hasOwn(field, 'default')) {
        try { validateSetupValue(field, field.default); }
        catch (error) { fail(`${path}.default`, error.message); }
      }
      if (field.prefill !== undefined && field.kind !== 'email') fail(`${path}.prefill`, 'account-email prefill requires an email field');
      if (field.kind === 'select') {
        const options = Array.isArray(field.options) ? field.options : [];
        const values = new Set();
        for (const option of options) {
          if (!option || typeof option.value !== 'string') continue;
          if (values.has(option.value)) fail(`${path}.options`, 'select option values must be unique');
          values.add(option.value);
        }
        if (Object.hasOwn(field, 'default') && !values.has(field.default)) {
          fail(`${path}.default`, 'select default must match a declared option value');
        }
      } else if (Object.hasOwn(field, 'options')) {
        fail(`${path}.options`, 'only select fields may declare options');
      }
    }

    if (Object.hasOwn(field, 'localDefault')) validateLocalDefault(field, `${path}.localDefault`);

    if (field.when !== undefined && field.when && typeof field.when === 'object') {
      validateCondition(field.when, `${path}.when`, index, true);
    }
    validatePresentations(field.presentations, `${path}.presentations`, index, true);
  }

  for (const [index, group] of data.groups.entries()) {
    if (!group || typeof group !== 'object') continue;
    validatePresentations(group.presentations, `$.groups[${index}].presentations`, data.fields.length, false);
  }

  for (const [index, name] of (Array.isArray(data.runtime?.exclude) ? data.runtime.exclude : []).entries()) {
    if (!fields.has(name)) fail(`$.runtime.exclude[${index}]`, 'runtime exclusion must reference a declared field');
  }

  const claims = data.steps.filter(step => step?.type === 'owner-claim');
  // Binding-free editions may perform only extension steps. An owner input
  // still requires its claim, and multiple claims remain ambiguous.
  const ownerInput = data.fields.some(field => field?.prefill === 'account-email');
  if (claims.length > 1 || (ownerInput && claims.length !== 1)) fail('$.steps', 'exactly one owner-claim step is required');
  for (const [index, step] of data.steps.entries()) {
    if (!step || typeof step !== 'object') continue;
    const path = `$.steps[${index}]`;
    if (step.type === 'extension') {
      if (Object.keys(step).some(key => !['type', 'id'].includes(key))) fail(path, 'extension steps accept only type and id');
      continue;
    }
    if (step.type !== 'owner-claim') continue;
    const allowed = step.mode === 'idp' ? ['type','mode','emailField','dependency','path'] : step.mode === 'signed'
      ? ['type', 'mode', 'emailField', 'tokenField', 'path']
      : ['type', 'mode', 'emailField', 'tokenField'];
    if (Object.keys(step).some(key => !allowed.includes(key))) fail(path, 'owner-claim step has fields that do not apply to its mode');
    const email = fields.get(step.emailField);
    if (!email || email.kind !== 'email' || email.prefill !== 'account-email') {
      fail(`${path}.emailField`, 'owner-claim must reference a prefilled public email field');
    }
    if (step.mode === 'idp') {
      if (!(data.dependencies??[]).some(d=>d.interface===step.dependency) || step.dependency!=='oidc-provider@1') fail(path, 'idp claim requires the declared identity dependency');
      if (step.path!=='/auth/owner-claim') fail(path, 'idp claim requires the owner claim path');
    } else if (step.mode === 'signed') {
      const token = fields.get(step.tokenField);
      if (!token || token.kind !== 'secret' || token.required !== true
        || !['hex', 'base64'].includes(token.generate) || token.ownerVisible !== false) {
        fail(`${path}.tokenField`, 'signed owner-claim must reference a required generated hidden secret');
      }
      if (typeof step.path !== 'string' || !safeSameAppPath(step.path)) {
        fail(`${path}.path`, 'signed owner-claim path must be a safe same-app absolute path');
      }
    } else if (step.mode === 'setup-token') {
      if (Object.hasOwn(step, 'path')) fail(`${path}.path`, 'legacy setup-token step does not declare a signed claim path');
      if (step.tokenField !== undefined) {
        const token = fields.get(step.tokenField);
        if (!token || token.kind !== 'secret' || token.required !== true
          || !['hex', 'base64'].includes(token.generate) || token.ownerVisible !== true) {
          fail(`${path}.tokenField`, 'legacy setup-token must reference a required generated owner-visible secret');
        }
      }
    }
  }

  // A value only the zero-setup local launch fills in: a literal for a public
  // field, a generated value for an entered secret, or the chosen local origin.
  function validateLocalDefault(field, path) {
    const value = field.localDefault;
    if (typeof value === 'string') {
      if (field.kind === 'secret') fail(path, 'a secret takes a generated local default, never a literal');
      else if (!value) fail(path, 'a literal local default must not be empty');
      else { try { validateSetupValue(field, value); } catch (error) { fail(path, error.message); } }
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (Object.hasOwn(value, 'generate') === Object.hasOwn(value, 'from')) {
      fail(path, 'local default must declare exactly one of generate or from');
    } else if (Object.hasOwn(value, 'generate')) {
      if (field.kind !== 'secret' || field.input !== 'entered') fail(path, 'a generated local default requires an entered secret');
    } else if (!['url', 'text'].includes(field.kind)) {
      fail(path, 'the local origin default requires a url or text field');
    }
  }

  function validateCondition(condition, path, beforeIndex, requireEarlier) {
    if (Object.hasOwn(condition, 'equals') === Object.hasOwn(condition, 'nonEmpty')) {
      fail(path, 'condition must declare exactly one of equals or nonEmpty');
      return;
    }
    const dependency = fields.get(condition.field);
    const dependencyIndex = fieldIndexes.get(condition.field);
    if (!dependency) {
      fail(`${path}.field`, 'condition must reference a declared field');
      return;
    }
    if (requireEarlier && dependencyIndex >= beforeIndex) {
      fail(`${path}.field`, 'condition must reference an earlier field');
      return;
    }
    if (condition.nonEmpty === true ? !PUBLIC_KINDS.has(dependency.kind) : dependency.kind !== 'text' && dependency.kind !== 'select') {
      fail(`${path}.field`, 'nonEmpty conditions require a public field; equality requires public text or select');
      return;
    }
    if (condition.nonEmpty !== true && dependency.kind === 'select' && Array.isArray(dependency.options)
      && !dependency.options.some(option => option?.value === condition.equals)) {
      fail(`${path}.equals`, 'condition value must match a declared select option');
    }
  }

  function validatePresentations(presentations, path, beforeIndex, requireEarlier) {
    if (!Array.isArray(presentations)) return;
    let discriminator;
    const conditions = [];
    for (const [variantIndex, presentation] of presentations.entries()) {
      if (!presentation || typeof presentation !== 'object' || !presentation.when) continue;
      const conditionPath = `${path}[${variantIndex}].when`;
      validateCondition(presentation.when, conditionPath, beforeIndex, requireEarlier);
      if (discriminator === undefined) discriminator = presentation.when.field;
      else if (discriminator !== presentation.when.field) {
        fail(`${path}[${variantIndex}].when.field`, 'presentation variants must share one condition field');
      }
      const condition = presentation.when;
      const overlap = conditions.find(previous => {
        if (previous.field !== condition.field) return false;
        if (previous.nonEmpty === true && condition.nonEmpty === true) return true;
        if (previous.nonEmpty === true) return typeof condition.equals === 'string' && condition.equals.length > 0;
        if (condition.nonEmpty === true) return typeof previous.equals === 'string' && previous.equals.length > 0;
        return previous.equals === condition.equals;
      });
      if (overlap) {
        fail(conditionPath, overlap.nonEmpty !== true && condition.nonEmpty !== true
          ? 'presentation condition values must be unique'
          : 'presentation conditions must not overlap');
      }
      conditions.push(condition);
      if (presentation.order !== undefined && presentation.order < 0) {
        fail(`${path}[${variantIndex}].order`, 'presentation order must be zero or greater');
      }
    }
  }
  return errors;
}

function safeSameAppPath(path) {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[?#]/.test(path)) return false;
  const parts = path.split('/');
  return parts.slice(1).every(part => part !== '.' && part !== '..' && (part.length > 0 || parts.length === 2));
}

/** Structural and cross-field validation used by the CLI and portable producer. */
export function validateSetupManifest(schema, data) {
  if (schema?.$id !== SETUP_SCHEMA_ID) throw new Error('Expected setup schema version 1');
  checkSchema(schema);
  const errors = validate(schema, data);
  if (errors.length) return [...businessFieldErrors(data), ...errors.map(error => {
    const match = error.match(/^(\$\.(fields|groups)\[(\d+)\]\.audience):/);
    if (!match) return error;
    const item = data[match[2]][Number(match[3])];
    return `${match[1]}: ${item.name ?? item.id} audience must be "owner" or "developer"`;
  })];
  return setupManifestSemanticErrors(data);
}
